export type FacilityCategory = "library" | "sports" | "campus" | "forms";

export interface FacilityService {
  id: string;
  name: string;
  category: FacilityCategory;
  url: string;
  description: string;
  lead_time?: string;
  booking: "integrated" | "portal" | "form";
  cli?: string;
}

export const FACILITY_SERVICES: readonly FacilityService[] = [
  {
    id: "library",
    name: "HKUL Libraries and Chi Wah Learning Commons",
    category: "library",
    url: "https://lib.hku.hk/general/e-form/book-a-space.html",
    description: "Study rooms, discussion rooms, study tables, computers, AV spaces and other HKUL facilities.",
    lead_time: "Depends on facility; Chi Wah study rooms can be booked two days ahead at midnight.",
    booking: "integrated",
    cli: "hku library",
  },
  {
    id: "sports",
    name: "CSE Sports Facilities Booking",
    category: "sports",
    url: "https://bs.cse.hku.hk/",
    description: "Sports courts, training rooms and Active gym sessions. Personal booking opens seven days ahead.",
    lead_time: "Individual: 7 days; internal group form: 28 days.",
    booking: "portal",
  },
  {
    id: "hkufbs",
    name: "HKU Facilities Booking (HKUFBS)",
    category: "campus",
    url: "https://hkufbs.hku.hk/fbs/centralbook/book/Web/",
    description: "Music rooms and other campus spaces, including CYMAC, FSCAC and Main Building MB221.",
    lead_time: "CYMAC and FSCAC rooms require at least 3 days.",
    booking: "portal",
  },
  {
    id: "library-venue",
    name: "HKUL Library Venue",
    category: "forms",
    url: "https://forms.office.com/r/apKkFvq0p2",
    description: "Application form for a Library venue. Submit at least eight weeks in advance.",
    lead_time: "At least 8 weeks.",
    booking: "form",
  },
  {
    id: "dil",
    name: "Digital Interactive Lab (DIL)",
    category: "forms",
    url: "https://forms.office.com/r/apKkFvq0p2",
    description: "Application form for the Digital Interactive Lab.",
    lead_time: "At least 10 working days.",
    booking: "form",
  },
  {
    id: "lic-classroom",
    name: "LIC Classroom",
    category: "forms",
    url: "https://forms.office.com/r/apKkFvq0p2",
    description: "Application form for the LIC Classroom.",
    lead_time: "At least 10 working days.",
    booking: "form",
  },
];

export function facilityById(id: string): FacilityService | undefined {
  const normalized = id.trim().toLowerCase();
  return FACILITY_SERVICES.find(service => service.id === normalized);
}
