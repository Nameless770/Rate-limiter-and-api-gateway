import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Registry } from './metrics.js';

/**
 * Process-level metrics: memory, CPU and event-loop delay. Event-loop delay is the number to watch under
 * load, since a proxy that spends its time in synchronous work shows up here before it shows up anywhere else.
 *
 * Returns a function that stops the event-loop sampler.
 */
export function registerProcessMetrics(registry: Registry): () => void {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();

  const memory = (field: 'rss' | 'heapUsed' | 'heapTotal' | 'external' | 'arrayBuffers') => () => [
    { labels: {}, value: process.memoryUsage()[field] },
  ];
  registry.gauge('process_resident_memory_bytes', 'Resident set size.', memory('rss'));
  registry.gauge('nodejs_heap_used_bytes', 'V8 heap in use.', memory('heapUsed'));
  registry.gauge('nodejs_heap_total_bytes', 'V8 heap reserved.', memory('heapTotal'));
  registry.gauge(
    'nodejs_external_memory_bytes',
    'Memory held by C++ objects bound to JS (buffers).',
    memory('external'),
  );

  registry.gauge(
    'process_cpu_seconds_total',
    'CPU time used by the process.',
    () => {
      const usage = process.cpuUsage();
      return [
        { labels: { mode: 'user' }, value: usage.user / 1e6 },
        { labels: { mode: 'system' }, value: usage.system / 1e6 },
      ];
    },
    'counter',
  );

  // Event-loop delay over the interval since the previous scrape, so each reading describes recent behaviour
  // instead of everything since startup.
  registry.gauge('nodejs_eventloop_delay_seconds', 'Event-loop delay since the previous scrape.', () => {
    const out = [
      { labels: { quantile: '0.5' }, value: delay.percentile(50) / 1e9 },
      { labels: { quantile: '0.99' }, value: delay.percentile(99) / 1e9 },
      { labels: { quantile: '1' }, value: delay.max / 1e9 },
    ];
    delay.reset();
    return out;
  });

  return () => {
    delay.disable();
  };
}
