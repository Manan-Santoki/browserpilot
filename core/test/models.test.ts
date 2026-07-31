import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_MODELS,
  modelCatalogue,
  parseModelCatalogue,
  withCurrentModel,
} from "../src/models";

describe("parseModelCatalogue", () => {
  test("reads bare ids and shows them as themselves", () => {
    expect(parseModelCatalogue("qwen3.7-plus, minimax-m3")).toEqual([
      { value: "qwen3.7-plus", label: "qwen3.7-plus" },
      { value: "minimax-m3", label: "minimax-m3" },
    ]);
  });

  test("reads id=Label pairs", () => {
    expect(parseModelCatalogue("qwen3.7-plus=Qwen 3.7 Plus")).toEqual([
      { value: "qwen3.7-plus", label: "Qwen 3.7 Plus" },
    ]);
  });

  test("a label may contain an equals sign", () => {
    // Only the first `=` separates the two; splitting on every one would
    // truncate a label at its first arithmetic-looking character.
    expect(parseModelCatalogue("m=Fast = cheap")).toEqual([{ value: "m", label: "Fast = cheap" }]);
  });

  test("blank entries and stray whitespace are ignored", () => {
    expect(parseModelCatalogue("  a ,, b  ,")).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  test("a repeated id keeps its first label", () => {
    expect(parseModelCatalogue("a=First, a=Second")).toEqual([{ value: "a", label: "First" }]);
  });

  test("unset or blank is an empty catalogue, not a default", () => {
    expect(parseModelCatalogue(undefined)).toEqual([]);
    expect(parseModelCatalogue("   ")).toEqual([]);
  });
});

describe("modelCatalogue", () => {
  test("falls back to the Claude family when talking to Anthropic", () => {
    expect(modelCatalogue(undefined, false)).toEqual(ANTHROPIC_MODELS);
  });

  test("never invents Claude models for a gateway", () => {
    // A gateway that has never heard of claude-opus-5 would 404 every session,
    // with nothing on screen to explain why.
    expect(modelCatalogue(undefined, true)).toEqual([]);
  });

  test("a configured catalogue wins in both modes", () => {
    const configured = [{ value: "m", label: "m" }];
    expect(modelCatalogue("m", true)).toEqual(configured);
    expect(modelCatalogue("m", false)).toEqual(configured);
  });
});

describe("withCurrentModel", () => {
  test("leaves the list alone when the current model is in it", () => {
    expect(withCurrentModel(ANTHROPIC_MODELS, "claude-sonnet-5")).toEqual(ANTHROPIC_MODELS);
  });

  test("keeps a stored model that has been dropped from the catalogue", () => {
    // Otherwise the picker silently rewrites it to whatever is listed first.
    const models = withCurrentModel(ANTHROPIC_MODELS, "retired-model");
    expect(models.at(-1)).toEqual({
      value: "retired-model",
      label: "retired-model · not in BP_MODELS",
    });
  });

  test("an empty current model adds nothing", () => {
    expect(withCurrentModel(ANTHROPIC_MODELS, "  ")).toEqual(ANTHROPIC_MODELS);
  });
});
