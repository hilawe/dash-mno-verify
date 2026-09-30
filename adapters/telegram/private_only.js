// Telegram verification happens only in a private chat with the bot (review finding F1, 2026-09-29). In
// a group, /verify posted the challenge and its instructions for the whole group to read, and a proof
// uploaded there was checked and answered there, so the group learned who sought or completed
// masternode verification. Account binding stops anyone else from using that proof or join link. It
// does not hide that the member asked. A refused request makes no gateway call and fetches no file,
// because the handler it guards never runs.
export const isPrivateChat = (ctx) => ctx?.chat?.type === "private";

export function privateOnly(handler, onRefuse) {
  return (ctx) => (isPrivateChat(ctx) ? handler(ctx) : onRefuse(ctx));
}

export const GROUP_VERIFY_REFUSAL =
  "For privacy, verification works only in a private chat with me. Open a private chat with this bot and send /verify there.";
