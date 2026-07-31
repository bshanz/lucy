/**
 * iMessage can't render markdown — Sendblue sends plain text. Convert the
 * model's light markdown into text that reads well in Messages:
 *  - **bold** and ## headers → Unicode sans-serif bold (𝗯𝗼𝗹𝗱)
 *  - [label](url) → label (url)
 *  - *italic* / `code` markers → stripped
 *  - "- " bullets → "• "
 *
 * Unicode bold only covers A-Z, a-z, 0-9; other characters pass through.
 */

function unicodeBold(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 65 && code <= 90) {
      out += String.fromCodePoint(0x1d5d4 + (code - 65)); // A-Z → 𝗔-𝗭
    } else if (code >= 97 && code <= 122) {
      out += String.fromCodePoint(0x1d5ee + (code - 97)); // a-z → 𝗮-𝘇
    } else if (code >= 48 && code <= 57) {
      out += String.fromCodePoint(0x1d7ec + (code - 48)); // 0-9 → 𝟬-𝟵
    } else {
      out += ch;
    }
  }
  return out;
}

export function toImessageText(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, t: string) => unicodeBold(t))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => unicodeBold(t))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/(^|\s)\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^(\s*)-\s+/gm, "$1• ");
}
