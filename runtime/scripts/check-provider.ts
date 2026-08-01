/**
 * Ask the configured provider whether it will answer, and say what it said.
 *
 *   bun run check:provider                 # the default model
 *   bun run check:provider qwen3.7-plus    # one specific model
 *   bun run check:provider --all           # every model in BP_MODELS
 *
 * Use it before pointing a deployment at a new gateway: it exercises the base
 * URL, the credential's header, and whether the model id means anything there
 * — the three things that are otherwise invisible until a session runs.
 */
import { checkProvider, formatCheck, messagesEndpoint } from "../src/agent/preflight";
import { describeProvider, loadConfig } from "../src/config";

const config = loadConfig(process.env);
const args = process.argv.slice(2);
const all = args.includes("--all");
const named = args.filter((arg) => !arg.startsWith("--"));

const models = all
  ? config.provider.models.map((model) => model.value)
  : named.length > 0
    ? named
    : [config.defaultModel];

console.log(`provider  ${describeProvider(config)}`);
console.log(`endpoint  ${messagesEndpoint(config.provider)}`);
console.log("");

let failed = 0;
for (const model of models) {
  const check = await checkProvider(config.provider, model);
  if (!check.ok) failed++;
  console.log(`${check.ok ? "✓" : "✗"} ${formatCheck(check)}`);
}

// Non-zero on failure so CI or a deploy step can gate on it.
process.exit(failed > 0 ? 1 : 0);
