import { slackChannel, defaultSlackAuth, type SlackMessage } from "eve/channels/slack";
import { connectSlackCredentials } from "@vercel/connect/eve";
import { nowInOwnerTz } from "#lib/reminders.js";

/**
 * Slack channel — Lucy's instant surface. Credentials (bot token + webhook
 * verification) are brokered by Vercel Connect; no SLACK_BOT_TOKEN or signing
 * secret env vars. Connector setup:
 *   FF_CONNECT_ENABLED=1 vercel connect create slack --name lucy
 *   vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes
 *
 * Lucy is a personal assistant: only the owner (OWNER_SLACK_USER_ID) may drive
 * her. Anyone else in the workspace is silently ignored — returning null
 * skips the message without a session or a reply.
 */

function ownerOnly(message: SlackMessage) {
  const ownerId = process.env.OWNER_SLACK_USER_ID;
  const author = message.author;
  if (!author || author.isBot) return false;
  if (!ownerId) {
    // Bootstrap aid: surfaces the would-be owner's id in logs before the env var is set.
    console.warn(`[slack] OWNER_SLACK_USER_ID not set; ignoring message from ${author.userId}`);
    return false;
  }
  if (author.userId !== ownerId) {
    console.warn(`[slack] ignoring message from non-owner ${author.userId}`);
    return false;
  }
  return true;
}

export default slackChannel({
  credentials: connectSlackCredentials("slack/lucy"),

  onDirectMessage(ctx, message) {
    if (!ownerOnly(message)) return null;
    return {
      auth: withChannelAttr(defaultSlackAuth(message, ctx), message),
      context: [`Current New York time: ${nowInOwnerTz()}.`],
    };
  },

  onAppMention(ctx, message) {
    if (!ownerOnly(message)) return null;
    return {
      auth: withChannelAttr(defaultSlackAuth(message, ctx), message),
      context: [`Current New York time: ${nowInOwnerTz()}.`],
    };
  },
});

function withChannelAttr(
  auth: ReturnType<typeof defaultSlackAuth>,
  message: SlackMessage,
) {
  if (!auth) return auth;
  return {
    ...auth,
    subject: "owner",
    attributes: {
      ...auth.attributes,
      channel: "slack",
      slackChannelId: message.channelId,
    },
  };
}
