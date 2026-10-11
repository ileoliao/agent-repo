import { createRequire } from 'module';

const load = createRequire(__filename);

/** Runs the headless scenario. Inert unless the launcher set LOOP_SIM_SUITE. */
export async function runSim(): Promise<void> {
  const suite = process.env.LOOP_SIM_SUITE;
  if (!suite) return;
  const mod = load(suite) as { main: () => Promise<void> };
  await mod.main();
}
