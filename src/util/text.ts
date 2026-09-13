/** Collapses whitespace and clips to `max` characters. */
export function oneLine(text: string | undefined, max = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clip(text: string | undefined, max: number): string {
  const value = (text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Strips the wrapper tags agents inject around the real user request. */
export function stripPromptEnvelope(text: string): string {
  let out = text;
  const request = out.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (request?.[1]) out = request[1];
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
    /^<recommended_plugins>/.test(head) ||
    /^Caveat: The messages below were generated/.test(head)
  );
}
