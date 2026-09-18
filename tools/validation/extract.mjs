// Extracts the "Sync and Push to Aliyun" run script from the workflow and writes it to a .sh file,
// so it can be executed under Git Bash with stubbed skopeo/aws.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "yaml";

const wf = process.argv[2];
const out = process.argv[3];
const doc = parse(readFileSync(wf, "utf8"));
const steps = doc.jobs.build.steps;
const sync = steps.find((s) => s.id === "sync_step");
const mail = steps.find((s) => (s.name ?? "").includes("Email"));

mkdirSync(out, { recursive: true });
writeFileSync(`${out}/sync.sh`, sync.run.replace(/\r\n/g, "\n"), "utf8");
writeFileSync(`${out}/mail.sh`, mail.run.replace(/\r\n/g, "\n"), "utf8");
console.log("extracted sync.sh:", sync.run.split("\n").length, "lines");
console.log("extracted mail.sh:", mail.run.split("\n").length, "lines");
