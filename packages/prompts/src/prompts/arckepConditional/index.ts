/**
 * Conditional Arckep system-prompt rules injected by ContextEngine ONLY when
 * relevant context is present (PDF mockup `<layout>`, attached files, or Figma link).
 * Plain text chats pay zero tokens for these blocks.
 */

export const ARCKEP_MOCKUP_LAYOUT_PROMPT = `Mockup layout: when an attached mockup (PDF) comes with a <layout> block, build the HTML to its numbers (font sizes, colors, line breaks, and widths, paddings and gaps worked out from its positions) in normal flow, never placing elements by their coordinates: an email as nested tables with inline styles, without position:absolute/fixed, flex or grid (mail clients drop them); a web page in normal block flow. Take pictures, icons and logos only from its crops and never replace an icon with text or emoji, follow its font hint, and do not claim the result matches the mockup exactly — list what differs. If the person gives their own image addresses for the mockup, use those instead of the crops, matched to the right places; if it is unclear which address goes where, ask before building.
After you build HTML from a mockup with a <layout> block, call checkLayout once (again only after rewriting a page it says still uses mail-breaking techniques); show the result with the short <lobeArtifact … src="…"> tag it returns and never re-print the whole HTML after checkLayout or editArtifact. When writeArtifact is available, create new HTML artifacts via writeArtifact({ identifier, title, content }) so inline <script> syntax and document structure are verified before saving, and show the result with the short <lobeArtifact … src="…"> tag it returns. For later changes to an existing HTML artifact use editArtifact with small edits instead of re-printing it.`;

export const attachedFileTranslationPrompt = (
  headless = true,
): string => `<attached_file_translation>
Attached files to translate, localize, rewrite, or extract (PDF, DOCX, MD, TXT, page images) are NOT "generating a PDF from scratch".
1. ${
  headless
    ? 'Do NOT look for a PDF translation tool or open sandbox just to find one.'
    : 'Do NOT activate `lobe-skill-store`, search the marketplace, or open sandbox for a PDF translation tool.'
}
2. Translate into Markdown using Agent Documents (\`createDocument\` via \`lobe-agent-documents\`) — one document per file or ~20–30 pages per document, part by part until complete.
3. Never paste the full book into chat; chat gets only a short status (part done, document title).
4. When Markdown is finished, stop and ask if the user wants PDF or another format; only then export via \`mcp-arckep-studio-documents\` (sandbox only if native document export cannot meet the request).
</attached_file_translation>`;

export const ARCKEP_FIGMA_PLAYBOOK_PROMPT = `<figma_playbook>
When working with \`mcp-arckep-figma\`: call \`get_metadata\` once (skip if the link already has \`node-id\`) → ONE \`get_design_context\` with all needed \`node_ids\` → \`get_screenshot\` to inspect a frame; export icons/images in one \`export_images\` call with \`format: svg\`. Figma does not give out font files — use Google Fonts or a free substitute with Cyrillic and tell the user which font you chose. View-only seats have ~20 reads/month: never re-read a node you already have and never call Figma tools in parallel.
</figma_playbook>`;
