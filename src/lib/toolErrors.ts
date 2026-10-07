/** A user-facing tool error. Its message is shown to the calling bot verbatim. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
const plural = (m: number) => (m === 1 ? "" : "s");

/** Exact texts from the packet (§7.2, §8.3, §8.4). Tests assert on these. */
export const msg = {
  // auth (§7.2)
  missingKey: "Missing API key. Send the header Authorization: Bearer <your Bot Bridge API key>.",
  invalidKey: "Invalid API key. Check the key in your connector settings, or ask the bridge admin for a new one.",
  disabledBot: "This bot is disabled on Bot Bridge. Ask the bridge admin to re-enable it.",
  tooManyAuth: "Too many failed authentication attempts. Wait 10 minutes and try again.",
  requestTooLarge: "Request too large.",
  methodNotAllowed: "Method not allowed.",

  // common (§8.4)
  rateMcp: (limit: number, retryAfterMs: number) => {
    const m = minutes(retryAfterMs);
    return `Rate limit reached: this bot can make ${limit} Bot Bridge tool calls per hour. Try again in about ${m} minute${plural(m)}.`;
  },
  internal: (requestId: string) =>
    `Bot Bridge hit an internal error. Try again in a minute. If it keeps happening, tell your owner. (ref ${requestId})`,

  // send_message (§8.3.3)
  emptyTo:
    "Say who the message is for: pass a contact's botId or exact name in 'to'. Use list_contacts to see your contacts.",
  emptyBody: "Message body is empty. Write something to send.",
  bodyTooLong: (n: number) =>
    `Message body is ${fmt(n)} characters; the limit is 8,000. Shorten it or split it into several messages.`,
  subjectTooLong: (n: number) => `Subject is ${fmt(n)} characters; the limit is 200.`,
  sendToSelf: "You can't send a message to yourself.",
  notConnected: (toShown: string) =>
    `You're not connected to '${toShown}'. Ask the bridge admin to approve the connection.`,
  recipientDisabled: (name: string) =>
    `'${name}' is turned off on Bot Bridge right now, so it can't receive messages. Try again later or let your owner know.`,
  replyNotFound: (id: string) => `Message '${id}' wasn't found in your conversations, so you can't reply to it.`,
  replyWrongConversation: (id: string, otherName: string, recipientName: string) =>
    `Message '${id}' belongs to your conversation with '${otherName}', not '${recipientName}'. Send it to '${otherName}', or leave out replyToId to start a new thread.`,
  rateSend: (limit: number, m: number) =>
    `Rate limit reached: this bot can send ${limit} messages per hour. Try again in about ${m} minute${plural(m)}.`,
  backlog: (name: string) =>
    `'${name}' already has 200 unread messages waiting, so Bot Bridge won't accept more until they catch up. Try again later.`,

  // check_inbox (§8.3.4)
  badLimit: "limit must be a whole number from 1 to 50.",

  // get_thread (§8.3.5)
  threadNotFound: (id: string) => `Thread '${id}' wasn't found in your conversations.`,
  threadRevoked: (otherName: string) =>
    `Your connection with '${otherName}' has been revoked, so this thread is closed. Ask the bridge admin if you need it reopened.`,

  // mark_read (§8.3.6)
  markNone: "Pass at least one message id in messageIds.",
  markTooMany: "You can mark at most 100 messages at a time. Split the list into smaller batches.",
};
