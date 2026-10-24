import { FileStore } from "../src/main/core/file-store";
import { Validator } from "../src/main/core/validator";

async function main(): Promise<void> {
  const project = process.argv[2]!;
  const validator = new Validator(new FileStore(project));
  const result = await validator.validate({ runGodot: false });
  const relevant = result.diagnostics.filter((item) => /decision_trees|combat_entity|decision_tree/.test(item.path));
  console.log(JSON.stringify({ total: result.diagnostics.length, relevant, diagnostics: result.diagnostics.slice(0, 20) }, null, 2));
}

void main();
