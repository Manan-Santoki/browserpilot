import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_MODELS,
  modelCatalogue,
  parseModelCatalogue,
  parseStoredCatalogue,
  resolveModel,
  withCurrentModel,
} from "../src/models";

describe("parseModelCatalogue", () => {
  test("reads bare ids and shows them as themselves", () => {
    expect(parseModelCatalogue("qwen3.7-plus, minimax-m3")).toEqual([
      { value: "qwen3.7-plus", label: "qwen3.7-plus", vision: true },
      { value: "minimax-m3", label: "minimax-m3", vision: true },
    ]);
  });

  test("reads id=Label pairs", () => {
    expect(parseModelCatalogue("qwen3.7-plus=Qwen 3.7 Plus")).toEqual([
      { value: "qwen3.7-plus", label: "Qwen 3.7 Plus", vision: true },
    ]);
  });

  test("a label may contain an equals sign", () => {
    // Only the first `=` separates the two; splitting on every one would
    // truncate a label at its first arithmetic-looking character.
    expect(parseModelCatalogue("m=Fast = cheap")).toEqual([
      { value: "m", label: "Fast = cheap", vision: true },
    ]);
  });

  test("blank entries and stray whitespace are ignored", () => {
    expect(parseModelCatalogue("  a ,, b  ,")).toEqual([
      { value: "a", label: "a", vision: true },
      { value: "b", label: "b", vision: true },
    ]);
  });

  test("a repeated id keeps its first label", () => {
    expect(parseModelCatalogue("a=First, a=Second")).toEqual([
      { value: "a", label: "First", vision: true },
    ]);
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
    const configured = [{ value: "m", label: "m", vision: true }];
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
      label: "retired-model · not in the catalogue",
      vision: true,
    });
  });

  test("an empty current model adds nothing", () => {
    expect(withCurrentModel(ANTHROPIC_MODELS, "  ")).toEqual(ANTHROPIC_MODELS);
  });
});

describe("parseStoredCatalogue", () => {
  test("reads what an administrator saved, flags and all", () => {
    expect(
      parseStoredCatalogue([
        { value: "mimo-v2.5", label: "MiMo V2.5", vision: true, format: "openai" },
        { value: "glm-5.2", label: "GLM 5.2", vision: false, format: "openai" },
      ]),
    ).toEqual([
      { value: "mimo-v2.5", label: "MiMo V2.5", vision: true, format: "openai" },
      { value: "glm-5.2", label: "GLM 5.2", vision: false, format: "openai" },
    ]);
  });

  test("an absent vision flag means sighted", () => {
    // A catalogue saved before the flag existed held only Claude models.
    expect(parseStoredCatalogue([{ value: "m" }])).toEqual([
      { value: "m", label: "m", vision: true, format: undefined },
    ]);
  });

  test("one malformed entry costs that entry, not the list", () => {
    // This is stored JSON written by a form that may have changed shape.
    expect(
      parseStoredCatalogue([null, { label: "no id" }, "nonsense", { value: "good" }]),
    ).toEqual([{ value: "good", label: "good", vision: true, format: undefined }]);
  });

  test("a nonsense format is dropped rather than trusted", () => {
    expect(parseStoredCatalogue([{ value: "m", format: "sideways" }])[0]?.format).toBeUndefined();
  });

  test("anything that is not a list is an empty catalogue", () => {
    expect(parseStoredCatalogue(undefined)).toEqual([]);
    expect(parseStoredCatalogue({ value: "m" })).toEqual([]);
  });
});

describe("resolveModel", () => {
  const catalogue = [
    { value: "a", label: "A", vision: true },
    { value: "b", label: "B", vision: true },
  ];

  test("a per-session choice outranks everything", () => {
    expect(resolveModel({ requested: "b", preferred: "a", fallback: "a", catalogue })).toBe("b");
  });

  test("a saved preference is used when nothing was chosen", () => {
    expect(resolveModel({ preferred: "b", fallback: "a", catalogue })).toBe("b");
  });

  test("a preference dropped from the catalogue does not win", () => {
    // Otherwise a stale preference silently 404s every session that person
    // starts, long after an admin removed the model.
    expect(resolveModel({ preferred: "retired", fallback: "a", catalogue })).toBe("a");
  });

  test("falls through to the deployment default, then the catalogue head", () => {
    expect(resolveModel({ fallback: "b", catalogue })).toBe("b");
    expect(resolveModel({ catalogue })).toBe("a");
  });

  test("an empty catalogue still honours an explicit default", () => {
    // A catalogue can be empty while the runtime is mid-reconfiguration; the
    // stored default is better than nothing to send.
    expect(resolveModel({ fallback: "a", catalogue: [] })).toBe("a");
    expect(resolveModel({ catalogue: [] })).toBeUndefined();
  });
});
