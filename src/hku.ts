import { runCli } from "./cli.js";

runCli(process.argv, { programName: "hku" }).then(code => {
  process.exitCode = code || process.exitCode;
});
