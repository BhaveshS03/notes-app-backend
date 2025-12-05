export function xmlToMarkdown(xml: string): string {
    let md = xml;

    // Normalize whitespace
    md = md.replace(/\r?\n|\r/g, "");

    // ---------- BLOCK ELEMENTS ----------

    // Headings <heading level="1">text</heading>
    md = md.replace(/<heading level="1">(.*?)<\/heading>/g, "# $1\n\n");
    md = md.replace(/<heading level="2">(.*?)<\/heading>/g, "## $1\n\n");
    md = md.replace(/<heading level="3">(.*?)<\/heading>/g, "### $1\n\n");
    md = md.replace(/<heading level="4">(.*?)<\/heading>/g, "#### $1\n\n");
    md = md.replace(/<heading level="5">(.*?)<\/heading>/g, "##### $1\n\n");
    md = md.replace(/<heading level="6">(.*?)<\/heading>/g, "###### $1\n\n");

    // Paragraphs
    md = md.replace(/<\/paragraph>\s*<paragraph>/g, "\n\n");
    md = md.replace(/<paragraph>/g, "");
    md = md.replace(/<\/paragraph>/g, "");

    // Blockquote
    md = md.replace(/<blockquote>/g, "> ");
    md = md.replace(/<\/blockquote>/g, "\n\n");

    // Code block <codeBlock language="js">...</codeBlock>
    md = md.replace(
        /<codeblock(?:\s+language="(.*?)")?>([\s\S]*?)<\/codeblock>/gi,
        (m, lang, code) => `\n\`\`\`${lang || ""}\n${code.trim()}\n\`\`\`\n\n`
    );

    // Bullet list
    md = md.replace(/<list type="bullet">/g, "");
    md = md.replace(/<\/list>/g, "\n\n");
    md = md.replace(/<listitem>(.*?)<\/listitem>/g, "- $1\n");

    // Ordered list
    let olCounter = 1;
    md = md.replace(/<olist>/g, "");
    md = md.replace(/<\/olist>/g, "\n\n");
    md = md.replace(/<olistitem>(.*?)<\/olistitem>/g, () => `${olCounter++}. $1\n`);

    // Hard breaks
    md = md.replace(/<hardbreak\s*\/>/g, "  \n");

    // ---------- INLINE MARKS ----------

    // Bold <bold>text</bold>
    md = md.replace(/<bold>(.*?)<\/bold>/g, "**$1**");

    // Italic <italic>text</italic>
    md = md.replace(/<italic>(.*?)<\/italic>/g, "*$1*");

    // Underline → preserve as italic (markdown has no underline)
    md = md.replace(/<underline>(.*?)<\/underline>/g, "_$1_");

    // Strikethrough <strike>text</strike>
    md = md.replace(/<strike>(.*?)<\/strike>/g, "~~$1~~");

    // Inline code <code>text</code>
    md = md.replace(/<code>(.*?)<\/code>/g, "`$1`");

    // Links <link href="url">text</link>
    md = md.replace(
        /<link href="(.*?)">(.*?)<\/link>/g,
        (_m, url, text) => `[${text}](${url})`
    );

    // ---------- CLEANUP ----------

    // Remove any XML tags we missed
    md = md.replace(/<[^>]+>/g, "");

    // Collapse multiple blank lines
    md = md.replace(/\n{3,}/g, "\n\n");

    return md.trim();
}
