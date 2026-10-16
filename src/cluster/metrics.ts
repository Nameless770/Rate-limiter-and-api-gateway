/**
 * Combine the Prometheus text of several workers into one scrape.
 *
 * Series are not summed. Each worker's series keeps its own identity under a `worker` label, so nothing is lost or
 * mislabelled by guessing how to combine it (a circuit-state gauge cannot be added up; a counter can, and
 * `sum without (worker) (...)` in the query does it). Worker labels are the worker's slot number, which survives a
 * restart, so a counter that restarts from zero looks like the ordinary counter reset Prometheus already handles.
 */

interface Family {
  help?: string;
  type?: string;
  samples: string[];
}

/** `name{a="b"} 1` becomes `name{worker="0",a="b"} 1`; `name 1` becomes `name{worker="0"} 1`. */
export function withLabel(sample: string, label: string): string {
  const brace = sample.indexOf('{');
  const space = sample.indexOf(' ');
  if (brace >= 0 && (space < 0 || brace < space)) {
    const empty = sample[brace + 1] === '}';
    return `${sample.slice(0, brace + 1)}${label}${empty ? '' : ','}${sample.slice(brace + 1)}`;
  }
  if (space < 0) return sample;
  return `${sample.slice(0, space)}{${label}}${sample.slice(space)}`;
}

export function mergeMetrics(parts: ReadonlyArray<{ worker: string; text: string }>): string {
  const families = new Map<string, Family>();
  const family = (name: string): Family => {
    let f = families.get(name);
    if (!f) {
      f = { samples: [] };
      families.set(name, f);
    }
    return f;
  };

  for (const { worker, text } of parts) {
    const label = `worker="${worker.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    let current: string | undefined;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const header = /^# (HELP|TYPE) (\S+) ?(.*)$/.exec(line);
      if (header) {
        const [, kind, name, rest] = header as unknown as [string, string, string, string];
        current = name;
        const f = family(name);
        if (kind === 'HELP') f.help ??= rest;
        else f.type ??= rest;
        continue;
      }
      if (line.startsWith('#')) continue;
      const name = current ?? (/^[^{\s]+/.exec(line)?.[0] as string);
      family(name).samples.push(withLabel(line, label));
    }
  }

  const out: string[] = [];
  for (const [name, f] of families) {
    if (f.help !== undefined) out.push(`# HELP ${name} ${f.help}`);
    if (f.type !== undefined) out.push(`# TYPE ${name} ${f.type}`);
    out.push(...f.samples);
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}
