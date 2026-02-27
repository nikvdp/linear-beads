import { describe, expect, test } from "bun:test";
import {
  parseLinearMailEnvelopeFromComment,
  serializeLinearMailEnvelope,
  type LinearMailEnvelope,
} from "../src/adapters/linear-mail.js";

describe("linear mail adapter envelope", () => {
  test("serializes and parses envelope with body", () => {
    const envelope: LinearMailEnvelope = {
      msg_id: "msg-1",
      thread_id: "thr-1",
      from: "AlphaAgent",
      to: ["BetaAgent", "GammaAgent"],
      created_at: "2026-01-01T00:00:00.000Z",
      reply_to: "msg-0",
      subject: "Subject",
      body_md: "hello world",
    };

    const body = `${serializeLinearMailEnvelope(envelope)}\n\nhello world`;
    const parsed = parseLinearMailEnvelopeFromComment(body);

    expect(parsed).not.toBeNull();
    expect(parsed?.envelope.msg_id).toBe("msg-1");
    expect(parsed?.envelope.thread_id).toBe("thr-1");
    expect(parsed?.envelope.from).toBe("AlphaAgent");
    expect(parsed?.envelope.to).toEqual(["BetaAgent", "GammaAgent"]);
    expect(parsed?.envelope.reply_to).toBe("msg-0");
    expect(parsed?.envelope.subject).toBe("Subject");
    expect(parsed?.bodyMd).toBe("hello world");
  });

  test("returns null for malformed envelope payload", () => {
    const parsed = parseLinearMailEnvelopeFromComment(
      "<!-- lb-mail-envelope:v1 not-base64 -->\n\nbody"
    );
    expect(parsed).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    const malformed = Buffer.from(
      JSON.stringify({ msg_id: "x", thread_id: "t", from: "a", to: [] }),
      "utf8"
    ).toString("base64");

    const parsed = parseLinearMailEnvelopeFromComment(
      `<!-- lb-mail-envelope:v1 ${malformed} -->\n\nbody`
    );
    expect(parsed).toBeNull();
  });
});
