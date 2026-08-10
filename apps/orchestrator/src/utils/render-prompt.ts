export function renderPrompt(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => variables[key] ?? `{{${key}}}`,
  );
}
