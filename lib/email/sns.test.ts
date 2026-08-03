import { describe, expect, it } from "vitest";
import { canonicalString, isAwsSnsUrl, suppressionSignals, type SnsEnvelope } from "./sns";

/**
 * SNS message verification and SES event interpretation.
 *
 * The bounce webhook writes to the suppression list, which decides who a
 * merchant is allowed to email. An attacker who could post fabricated events
 * would be able to cut a store off from its own customers silently — so the
 * host check and the canonical string are tested as security boundaries, not as
 * parsing details.
 */

describe("isAwsSnsUrl", () => {
  it("accepts a real SNS signing certificate host", () => {
    expect(
      isAwsSnsUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem"),
    ).toBe(true);
    expect(isAwsSnsUrl("https://sns.eu-west-2.amazonaws.com/cert.pem")).toBe(true);
  });

  it("rejects lookalike hosts that a suffix check would let through", () => {
    // Each of these ends with something that "contains" amazonaws.com.
    expect(isAwsSnsUrl("https://sns.us-east-1.amazonaws.com.attacker.net/cert.pem")).toBe(false);
    expect(isAwsSnsUrl("https://evil-amazonaws.com/cert.pem")).toBe(false);
    expect(isAwsSnsUrl("https://notsns.us-east-1.amazonaws.com/cert.pem")).toBe(false);
  });

  it("rejects non-SNS AWS hosts", () => {
    // The certificate must come from SNS, not from any AWS service an attacker
    // can upload a file to.
    expect(isAwsSnsUrl("https://s3.amazonaws.com/bucket/cert.pem")).toBe(false);
  });

  it("rejects plaintext and non-HTTP schemes", () => {
    expect(isAwsSnsUrl("http://sns.us-east-1.amazonaws.com/cert.pem")).toBe(false);
    expect(isAwsSnsUrl("file:///etc/passwd")).toBe(false);
    expect(isAwsSnsUrl("not a url")).toBe(false);
  });
});

describe("canonicalString", () => {
  const notification: SnsEnvelope = {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: "arn:aws:sns:us-east-1:1:ses-events",
    Message: '{"eventType":"Bounce"}',
    Timestamp: "2026-08-01T00:00:00.000Z",
    SignatureVersion: "1",
    Signature: "sig",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
  };

  it("emits the signed fields in AWS's order", () => {
    expect(canonicalString(notification)).toBe(
      "Message\n" +
        '{"eventType":"Bounce"}\n' +
        "MessageId\nm-1\n" +
        "Timestamp\n2026-08-01T00:00:00.000Z\n" +
        "TopicArn\narn:aws:sns:us-east-1:1:ses-events\n" +
        "Type\nNotification\n",
    );
  });

  it("omits an absent Subject rather than signing an empty one", () => {
    // Including `Subject\n\n` produces a string SNS never signed, and every
    // signature check then fails for a reason nothing reports.
    expect(canonicalString(notification)).not.toContain("Subject");
    expect(canonicalString({ ...notification, Subject: "hi" })).toContain("Subject\nhi\n");
  });

  it("uses the subscription field set for a confirmation", () => {
    const confirmation: SnsEnvelope = {
      ...notification,
      Type: "SubscriptionConfirmation",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
      Token: "tok",
    };
    const s = canonicalString(confirmation);
    expect(s).toContain("SubscribeURL");
    expect(s).toContain("Token\ntok\n");
  });

  it("refuses an unknown message type instead of signing something arbitrary", () => {
    expect(canonicalString({ ...notification, Type: "SomethingElse" })).toBeNull();
  });
});

describe("suppressionSignals", () => {
  it("suppresses a permanent bounce", () => {
    const signals = suppressionSignals({
      eventType: "Bounce",
      mail: { messageId: "msg-1" },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        bouncedRecipients: [{ emailAddress: "gone@example.com" }],
      },
    });
    expect(signals).toEqual([
      { email: "gone@example.com", reason: "bounce", detail: "NoEmail", messageId: "msg-1" },
    ]);
  });

  it("does NOT suppress a transient bounce", () => {
    // A full mailbox or a greylisting server. Suppressing here would cut off a
    // paying customer permanently for a problem that fixes itself, and the
    // merchant would never learn why their receipts stopped arriving.
    expect(
      suppressionSignals({
        eventType: "Bounce",
        mail: { messageId: "msg-2" },
        bounce: {
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
          bouncedRecipients: [{ emailAddress: "busy@example.com" }],
        },
      }),
    ).toEqual([]);
  });

  it("always suppresses a complaint", () => {
    const signals = suppressionSignals({
      eventType: "Complaint",
      mail: { messageId: "msg-3" },
      complaint: {
        complaintFeedbackType: "abuse",
        complainedRecipients: [{ emailAddress: "angry@example.com" }],
      },
    });
    expect(signals[0]).toMatchObject({ email: "angry@example.com", reason: "complaint" });
  });

  it("ignores deliveries, opens and clicks", () => {
    expect(suppressionSignals({ eventType: "Delivery", mail: { messageId: "m" } })).toEqual([]);
    expect(suppressionSignals({ eventType: "Open", mail: { messageId: "m" } })).toEqual([]);
    expect(suppressionSignals({})).toEqual([]);
  });

  it("reads the legacy notificationType as well as eventType", () => {
    // SNS-direct SES notifications use `notificationType`; configuration-set
    // event destinations use `eventType`. Both reach the same endpoint.
    const signals = suppressionSignals({
      notificationType: "Complaint",
      mail: { messageId: "m" },
      complaint: { complainedRecipients: [{ emailAddress: "x@example.com" }] },
    });
    expect(signals).toHaveLength(1);
  });

  it("returns one signal per recipient on a multi-recipient bounce", () => {
    const signals = suppressionSignals({
      eventType: "Bounce",
      mail: { messageId: "m" },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [
          { emailAddress: "a@example.com" },
          { emailAddress: "b@example.com" },
        ],
      },
    });
    expect(signals.map((s) => s.email)).toEqual(["a@example.com", "b@example.com"]);
  });
});
