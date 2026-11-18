import { Fragment, type ReactNode } from "react";

/** Minimal, safe Markdown: paragraphs, "- " bullets, **bold**, `code`. No HTML injection. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith("**") ? (
        <strong key={i++} className="font-semibold text-ink">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code key={i++} className="num rounded bg-surface-3 px-1 text-[0.9em]">
          {tok.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-ink-2">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const bullets = lines.filter((l) => /^\s*[-*•]\s+/.test(l));
        if (bullets.length && bullets.length === lines.length) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5 marker:text-ink-3">
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {/^\s*[-*•]\s+/.test(l) ? "• " : null}
                {inline(l.replace(/^\s*[-*•]\s+/, "").replace(/^#+\s*/, ""))}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
