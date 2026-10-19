import { z } from "zod";

import {
  bookLibrarySpace,
  cancelLibraryBooking,
  findLibrarySlots,
  listLibraryBookings,
  loadLibraryFacilities,
} from "../library.js";
import { filterLibraryFacilities } from "../library-core.js";
import { FACILITY_SERVICES } from "../facilities.js";
import { prepareFacilityRequest } from "../facility-requests.js";
import {
  bookCseSpace,
  findCseSlots,
  getCseSessionStatus,
  listCseActivities,
  loadCsePortal,
} from "../cse.js";
import { bookHkufbsSpace, findHkufbsSlots, loadHkufbsCatalog } from "../hkufbs.js";
import {
  getMailAttachments,
  getMailMessage,
  listMailMessages,
  sendMail,
  validateSendMail,
} from "../mail-core.js";
import { storedMailConfig } from "../mail.js";
import type { McpExtraTool } from "./server.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export interface HkuMcpToolsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function createHkuMcpTools(options: HkuMcpToolsOptions = {}): McpExtraTool[] {
  const common = {
    homeDir: options.homeDir,
    env: options.env,
  };

  return [
    tool(
      "mail_inbox",
      "List messages in the configured forwarding 163 mailbox. Search matches sender and subject.",
      z.object({
        query: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(200).default(20),
        unread: z.boolean().default(false),
        today: z.boolean().default(false),
        search_body: z.boolean().default(false),
      }).strict(),
      READ,
      async args => {
        const input = parse(z.object({
          query: z.string().trim().min(1).optional(),
          limit: z.number().int().min(1).max(200).default(20),
          unread: z.boolean().default(false),
          today: z.boolean().default(false),
          search_body: z.boolean().default(false),
        }).strict(), args);
        const config = await storedMailConfig(common);
        const messages = await listMailMessages(config, {
          limit: input.limit,
          unread: input.unread,
          search: input.query,
          searchBody: input.search_body,
          ...(input.today ? { since: new Date() } : {}),
        });
        return { structuredContent: { messages, total: messages.length } };
      },
    ),
    tool(
      "mail_read",
      "Read one message from the 163 mailbox by IMAP UID.",
      z.object({ uid: z.string().regex(/^\d+$/u) }).strict(),
      READ,
      async args => {
        const input = z.object({ uid: z.string().regex(/^\d+$/u) }).strict().parse(args);
        const message = await getMailMessage(await storedMailConfig(common), input.uid);
        return { structuredContent: { message } };
      },
    ),
    tool(
      "mail_attachments",
      "List attachment names and sizes for one 163 mailbox message.",
      z.object({ uid: z.string().regex(/^\d+$/u) }).strict(),
      READ,
      async args => {
        const input = z.object({ uid: z.string().regex(/^\d+$/u) }).strict().parse(args);
        const attachments = (await getMailAttachments(await storedMailConfig(common), input.uid))
          .map(({ data: _data, ...info }) => info);
        return { structuredContent: { attachments, total: attachments.length } };
      },
    ),
    tool(
      "mail_send",
      "Send an email through 163 SMTP. Defaults to dry_run=true; set dry_run=false only after showing the exact message to the user.",
      z.object({
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        subject: z.string().trim().min(1),
        body: z.string().trim().min(1),
        html: z.boolean().default(false),
        dry_run: z.boolean().default(true),
      }).strict(),
      WRITE,
      async args => {
        const input = z.object({
          to: z.array(z.string()).min(1),
          cc: z.array(z.string()).optional(),
          subject: z.string().trim().min(1),
          body: z.string().trim().min(1),
          html: z.boolean().default(false),
          dry_run: z.boolean().default(true),
        }).strict().parse(args);
        const plan = validateSendMail(input);
        if (input.dry_run) return { structuredContent: { planned: plan } };
        const receipt = await sendMail(await storedMailConfig(common), plan);
        return { structuredContent: receipt };
      },
    ),
    tool(
      "library_facilities",
      "List HKU Library bookable facility types with current availability counts.",
      z.object({
        library: z.string().trim().min(1).optional(),
        facility_type: z.string().trim().min(1).optional(),
        available_only: z.boolean().default(false),
      }).strict(),
      READ,
      async args => {
        const input = z.object({
          library: z.string().trim().min(1).optional(),
          facility_type: z.string().trim().min(1).optional(),
          available_only: z.boolean().default(false),
        }).strict().parse(args);
        const result = filterLibraryFacilities(await loadLibraryFacilities(options.fetchImpl), {
          library: input.library,
          type: input.facility_type,
          availableOnly: input.available_only,
        });
        return { structuredContent: { ...result, total: result.facilities.length } };
      },
    ),
    tool(
      "library_slots",
      "List exact HKU facility rooms and available time sessions. This is read-only.",
      z.object({
        location: z.string().trim().min(1).default("Chi Wah Learning Commons"),
        facility_type: z.string().trim().min(1).default("Study Room"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        floor: z.string().trim().min(1).optional(),
        room: z.string().trim().min(1).optional(),
        start: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
        end: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
      }).strict(),
      READ,
      async args => {
        const input = z.object({
          location: z.string().trim().min(1).default("Chi Wah Learning Commons"),
          facility_type: z.string().trim().min(1).default("Study Room"),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
          floor: z.string().trim().min(1).optional(),
          room: z.string().trim().min(1).optional(),
          start: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
          end: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
        }).strict().parse(args);
        const result = await findLibrarySlots({
          location: input.location,
          facilityType: input.facility_type,
          date: input.date,
          floor: input.floor,
          room: input.room,
          startTime: input.start,
          endTime: input.end,
        }, {
          homeDir: options.homeDir,
          env: options.env,
          fetchImpl: options.fetchImpl,
        });
        return { structuredContent: { ...result, total: result.slots.length } };
      },
    ),
    tool(
      "library_bookings",
      "List the authenticated user's HKUL bookings.",
      z.object({}).strict(),
      READ,
      async args => {
        z.object({}).strict().parse(args);
        const bookings = await listLibraryBookings({
          homeDir: options.homeDir,
          env: options.env,
          fetchImpl: options.fetchImpl,
        });
        return { structuredContent: { bookings, total: bookings.length } };
      },
    ),
    tool(
      "library_book",
      "Book one exact HKU facility slot. Defaults to dry_run=true; real submission requires dry_run=false and accept_policy=true.",
      z.object({
        location: z.string().trim().min(1).default("Chi Wah Learning Commons"),
        facility_type: z.string().trim().min(1).default("Study Room"),
        room: z.string().trim().min(1),
        floor: z.string().trim().min(1).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        start: z.string().regex(/^\d{2}:\d{2}$/u),
        end: z.string().regex(/^\d{2}:\d{2}$/u),
        booking_url: z.string().url().optional(),
        dry_run: z.boolean().default(true),
        accept_policy: z.boolean().default(false),
      }).strict(),
      WRITE,
      async args => {
        const input = z.object({
          location: z.string().trim().min(1).default("Chi Wah Learning Commons"),
          facility_type: z.string().trim().min(1).default("Study Room"),
          room: z.string().trim().min(1),
          floor: z.string().trim().min(1).optional(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
          start: z.string().regex(/^\d{2}:\d{2}$/u),
          end: z.string().regex(/^\d{2}:\d{2}$/u),
          booking_url: z.string().url().optional(),
          dry_run: z.boolean().default(true),
          accept_policy: z.boolean().default(false),
        }).strict().parse(args);
        if (!input.dry_run && !input.accept_policy) {
          throw new Error("Real booking requires accept_policy=true.");
        }
        let bookingUrl = input.booking_url;
        if (!bookingUrl) {
          const availability = await findLibrarySlots({
            location: input.location,
            facilityType: input.facility_type,
            date: input.date,
            floor: input.floor,
            room: input.room,
            startTime: input.start,
            endTime: input.end,
          }, {
            homeDir: options.homeDir,
            env: options.env,
            fetchImpl: options.fetchImpl,
          });
          if (availability.slots.length !== 1) {
            throw new Error(availability.slots.length
              ? "Multiple slots match; narrow the exact room, floor, date and time."
              : "That exact HKU slot is not currently available.");
          }
          bookingUrl = availability.slots[0].booking_url;
        }
        const result = await bookLibrarySpace(bookingUrl, {
          homeDir: options.homeDir,
          env: options.env,
          fetchImpl: options.fetchImpl,
          dryRun: input.dry_run,
          startTime: input.start,
          endTime: input.end,
        });
        return { structuredContent: { ...result } };
      },
    ),
    tool(
      "library_cancel",
      "Cancel one exact HKU booking. Defaults to dry_run=true; real cancellation requires dry_run=false and confirm_cancel=true.",
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        start: z.string().regex(/^\d{2}:\d{2}$/u),
        end: z.string().regex(/^\d{2}:\d{2}$/u),
        location: z.string().trim().min(1),
        floor: z.string().trim().min(1).optional(),
        room: z.string().trim().min(1),
        dry_run: z.boolean().default(true),
        confirm_cancel: z.boolean().default(false),
      }).strict(),
      WRITE,
      async args => {
        const input = z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          start: z.string().regex(/^\d{2}:\d{2}$/u),
          end: z.string().regex(/^\d{2}:\d{2}$/u),
          location: z.string().trim().min(1),
          floor: z.string().trim().min(1).optional(),
          room: z.string().trim().min(1),
          dry_run: z.boolean().default(true),
          confirm_cancel: z.boolean().default(false),
        }).strict().parse(args);
        if (!input.dry_run && !input.confirm_cancel) throw new Error("Real cancellation requires confirm_cancel=true.");
        const result = await cancelLibraryBooking({
          date: input.date,
          start: input.start,
          end: input.end,
          location: input.location,
          floor: input.floor,
          facility: input.room,
        }, {
          homeDir: options.homeDir,
          env: options.env,
          fetchImpl: options.fetchImpl,
          dryRun: input.dry_run,
        });
        return { structuredContent: { ...result } };
      },
    ),
    tool(
      "facility_services",
      "List every HKU facility booking service covered by the CLI, including integrated, portal and form workflows.",
      z.object({ category: z.enum(["library", "sports", "campus", "forms"]).optional() }).strict(),
      READ,
      async args => {
        const input = z.object({ category: z.enum(["library", "sports", "campus", "forms"]).optional() }).strict().parse(args);
        const services = FACILITY_SERVICES.filter(service => !input.category || service.category === input.category);
        return { structuredContent: { services, total: services.length } };
      },
    ),
    tool(
      "facility_request_prepare",
      "Check minimum notice and build the checklist for a form-backed HKU facility request. This never submits the form.",
      z.object({
        service: z.string().trim().min(1),
        event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        purpose: z.string().trim().min(1).optional(),
        attendees: z.number().int().positive().optional(),
        requester: z.string().trim().min(1).optional(),
        contact: z.string().trim().min(1).optional(),
      }).strict(),
      READ,
      async args => {
        const input = z.object({
          service: z.string().trim().min(1),
          event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          purpose: z.string().trim().min(1).optional(),
          attendees: z.number().int().positive().optional(),
          requester: z.string().trim().min(1).optional(),
          contact: z.string().trim().min(1).optional(),
        }).strict().parse(args);
        return {
          structuredContent: { ...prepareFacilityRequest({
            service: input.service,
            eventDate: input.event_date,
            purpose: input.purpose,
            attendees: input.attendees,
            requester: input.requester,
            contact: input.contact,
          }) },
        };
      },
    ),
    tool(
      "cse_sports_status",
      "Check whether the saved CSE Sports Facilities booking session is authenticated.",
      z.object({}).strict(),
      READ,
      async args => {
        z.object({}).strict().parse(args);
        return {
          structuredContent: { ...await getCseSessionStatus(common) },
        };
      },
    ),
    tool(
      "cse_sports_home",
      "Read the authenticated CSE Sports Facilities booking landing page and its booking links.",
      z.object({}).strict(),
      READ,
      async args => {
        z.object({}).strict().parse(args);
        const page = await loadCsePortal({ ...common, interactive: false });
        return { structuredContent: { ...page, link_count: page.links.length } };
      },
    ),
    tool(
      "cse_sports_activities",
      "List live CSE sports activities, booking codes, and individual/group eligibility.",
      z.object({}).strict(),
      READ,
      async args => {
        z.object({}).strict().parse(args);
        const activities = await listCseActivities({ fetchImpl: options.fetchImpl });
        return { structuredContent: { activities, total: activities.length } };
      },
    ),
    tool(
      "cse_sports_slots",
      "List live CSE room availability. Codes are A free, B booked, C confirmed, and U unavailable.",
      z.object({
        activity: z.string().trim().min(1),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        venue: z.string().trim().min(1).optional(),
        available_only: z.boolean().default(true),
      }).strict(),
      READ,
      async args => {
        const input = z.object({
          activity: z.string().trim().min(1),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          venue: z.string().trim().min(1).optional(),
          available_only: z.boolean().default(true),
        }).strict().parse(args);
        const result = await findCseSlots({
          activity: input.activity,
          date: input.date,
          venue: input.venue,
          availableOnly: input.available_only,
        }, { fetchImpl: options.fetchImpl });
        return { structuredContent: { ...result, total: result.slots.length } };
      },
    ),
    tool(
      "cse_sports_book",
      "Create one exact CSE room booking. Defaults to dry_run=true; real submission requires accept_policy=true and a matching confirmation token.",
      z.object({
        activity: z.string().trim().min(1),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        venue: z.string().trim().min(1).optional(),
        room: z.string().trim().min(1),
        start: z.string().regex(/^\d{2}:\d{2}$/u),
        dry_run: z.boolean().default(true),
        accept_policy: z.boolean().default(false),
        confirm_token: z.string().trim().min(1).optional(),
      }).strict(),
      WRITE,
      async args => {
        const input = z.object({
          activity: z.string().trim().min(1),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          venue: z.string().trim().min(1).optional(),
          room: z.string().trim().min(1),
          start: z.string().regex(/^\d{2}:\d{2}$/u),
          dry_run: z.boolean().default(true),
          accept_policy: z.boolean().default(false),
          confirm_token: z.string().trim().min(1).optional(),
        }).strict().parse(args);
        if (!input.dry_run && !input.accept_policy) throw new Error("Real CSE booking requires accept_policy=true.");
        const bookingInput = {
          activity: input.activity,
          date: input.date,
          venue: input.venue,
          room: input.room,
          start: input.start,
        };
        if (!input.dry_run) {
          const preview = await bookCseSpace(bookingInput, {
            ...common,
            fetchImpl: options.fetchImpl,
            dryRun: true,
          });
          const token = [
            preview.plan.activity_code,
            preview.plan.room_code,
            preview.plan.date,
            preview.plan.start_time,
          ].join(":");
          if (input.confirm_token !== token) {
            throw new Error(`Real CSE booking requires confirm_token='${token}'.`);
          }
        }
        const result = await bookCseSpace(bookingInput, {
          ...common,
          fetchImpl: options.fetchImpl,
          dryRun: input.dry_run,
        });
        return { structuredContent: { ...result } };
      },
    ),
    tool(
      "hkufbs_resources",
      "List live HKUFBS campus and music-room resources with their numeric ids.",
      z.object({}).strict(),
      READ,
      async args => {
        z.object({}).strict().parse(args);
        const { catalog } = await loadHkufbsCatalog({ ...common, interactive: false });
        return { structuredContent: { resources: catalog.resources, total: catalog.resources.length } };
      },
    ),
    tool(
      "hkufbs_slots",
      "Find live HKUFBS campus-room openings. This is read-only.",
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        resource: z.string().trim().min(1).optional(),
        duration_minutes: z.number().int().min(30).max(720).default(30),
        start: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
        end: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
      }).strict(),
      READ,
      async args => {
        const input = z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
          resource: z.string().trim().min(1).optional(),
          duration_minutes: z.number().int().min(30).max(720).default(30),
          start: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
          end: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
        }).strict().parse(args);
        const result = await findHkufbsSlots({
          date: input.date,
          endDate: input.end_date,
          resource: input.resource,
          durationMinutes: input.duration_minutes,
          start: input.start,
          end: input.end,
        }, { ...common, interactive: false });
        return { structuredContent: { ...result, total: result.openings.length } };
      },
    ),
    tool(
      "hkufbs_book",
      "Create an exact HKUFBS reservation. Defaults to dry_run=true; real submission also requires accept_policy=true and confirm_resource_id matching the live resource id.",
      z.object({
        resource: z.string().trim().min(1),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        start: z.string().regex(/^\d{2}:\d{2}$/u),
        end: z.string().regex(/^\d{2}:\d{2}$/u),
        contact: z.string().trim().min(1).optional(),
        uid: z.string().regex(/^\d{10}$/u).optional(),
        title: z.string().trim().min(1).optional(),
        description: z.string().trim().min(1).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        dry_run: z.boolean().default(true),
        accept_policy: z.boolean().default(false),
        confirm_resource_id: z.string().regex(/^\d+$/u).optional(),
      }).strict(),
      WRITE,
      async args => {
        const input = z.object({
          resource: z.string().trim().min(1),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          start: z.string().regex(/^\d{2}:\d{2}$/u),
          end: z.string().regex(/^\d{2}:\d{2}$/u),
          contact: z.string().trim().min(1).optional(),
          uid: z.string().regex(/^\d{10}$/u).optional(),
          title: z.string().trim().min(1).optional(),
          description: z.string().trim().min(1).optional(),
          attributes: z.record(z.string(), z.string()).optional(),
          dry_run: z.boolean().default(true),
          accept_policy: z.boolean().default(false),
          confirm_resource_id: z.string().regex(/^\d+$/u).optional(),
        }).strict().parse(args);
        if (!input.dry_run && !input.accept_policy) throw new Error("Real HKUFBS booking requires accept_policy=true.");
        const bookingInput = {
          resource: input.resource,
          date: input.date,
          start: input.start,
          end: input.end,
          contact: input.contact,
          uid: input.uid,
          title: input.title,
          description: input.description,
          attributes: input.attributes,
          acceptPolicy: input.accept_policy,
        };
        if (!input.dry_run) {
          const preview = await bookHkufbsSpace(bookingInput, {
            ...common,
            interactive: false,
            dryRun: true,
          });
          if (input.confirm_resource_id !== preview.plan.resource_id) {
            throw new Error(`Real HKUFBS booking requires confirm_resource_id=${preview.plan.resource_id}.`);
          }
        }
        const result = await bookHkufbsSpace({
          ...bookingInput,
          dryRun: input.dry_run,
        }, { ...common, interactive: false, dryRun: input.dry_run });
        return { structuredContent: { ...result } };
      },
    ),
  ];
}

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  annotations: Record<string, unknown>,
  call: (args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown>; payload?: unknown }>,
): McpExtraTool {
  return {
    name,
    description,
    inputSchema: compactSchema(z.toJSONSchema(schema, { io: "input" })),
    annotations,
    call,
  };
}

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, item]) => [key, compactSchema(item)]));
  }
  return value;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(value);
}
