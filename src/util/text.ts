/** Collapses whitespace and clips to `max` characters. */
export function oneLine(text: string | undefined, max = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clip(text: string | undefined, max: number): string {
  const value = (text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Strips the wrapper tags and ambient blocks agents inject around a real request. */
export function stripPromptEnvelope(text: string): string {
  let out = text;
  const request = out.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (request?.[1]) out = request[1];

  // Codex answers to its own clarifying questions carry the reply in `answer`.
  if (out.includes('<send_user_message_question_reply>')) {
    const answers = [...out.matchAll(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      (m[1] ?? '').replace(/\\"/g, '"').replace(/\\n/g, ' '),
    );
    if (answers.length) return answers.join('\n').trim();
  }

  out = out
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/<image\s[^>]*>[\s\S]*?<\/image>/g, '');

  // Attachment/ambient preambles keep the actual prompt behind a `## My request:` heading.
  const marker = out.lastIndexOf('## My request:');
  if (marker !== -1) out = out.slice(marker + '## My request:'.length);

  out = out
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '');
  return out.trim();
}

/** Boilerplate the agents prepend to the first turn — never a real request. */
export function looksLikeInstructions(text: string): boolean {
  const head = text.slice(0, 400);
  return (
    /^#\s*AGENTS\.md/i.test(head) ||
    /<INSTRUCTIONS>/.test(head) ||
    /<user_instructions>/.test(head) ||
    /<environment_context>/.test(head) ||
    /^<permissions instructions>/.test(head) ||
    // Grok opens every session with an ambient `<user_info>/<git_status>/<rules>`
    // block; the real prompt arrives as its own message right after it.
    /^<user_info>/.test(head) ||
    /^<recommended_plugins>/.test(head) ||
    /^Caveat: The messages below were generated/.test(head)
  );
}
