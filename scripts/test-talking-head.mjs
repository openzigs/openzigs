import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openzigs", "config.json"), "utf8"));
const token = cfg.auth.token;
const imageB64 = fs.readFileSync("C:\\Users\\mgbre\\Downloads\\PXL_20260411_231047382.MP.jpg").toString("base64");

const body = JSON.stringify({
  text: "Good morning everyone, and welcome to today's presentation on artificial intelligence and its transformative impact on modern software development. Over the past decade, we have witnessed an unprecedented acceleration in the capabilities of machine learning systems. What once required entire teams of specialized engineers can now be accomplished in a matter of hours with the right tools and frameworks. In this session, I want to walk you through three key areas where AI is fundamentally changing how we build and deploy software applications.",
  f5ttsProfileId: "PkxatgMvckn8kqYu4aHhF",
  videoPrompt: "A person speaking in a studio",
  referenceImage: imageB64,
  lipsyncModelVersion: "v1.5",
  inferenceSteps: 20,
  guidanceScale: 1.5,
  maxDurationSec: 30,
});

console.log(`Submitting talking head job (body size: ${(body.length / 1024).toFixed(0)} KB)...`);

const res = await fetch("http://localhost:3000/api/queue/pipelines/talking-head", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body,
});

const text = await res.text();
console.log(`Status: ${res.status}`);
console.log(text);
