/**
 * Generates sample arguments from a JSON Schema parameters object.
 * Used to create test inputs for smoke testing generated skills.
 */
export function generateSampleArgs(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || schema.type !== "object" || !schema.properties) {
    return {};
  }

  const props = schema.properties as Record<string, any>;
  const result: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(props)) {
    result[key] = generateValue(prop);
  }

  return result;
}

function generateValue(prop: any): unknown {
  if (!prop) return null;

  // If enum is defined, pick the first value
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[0];
  }

  // If default is defined, use it
  if (prop.default !== undefined) {
    return prop.default;
  }

  // If example is defined, use it
  if (prop.example !== undefined) {
    return prop.example;
  }

  switch (prop.type) {
    case "string":
      return "test";
    case "number":
    case "integer":
      return prop.minimum ?? 42;
    case "boolean":
      return true;
    case "array":
      if (prop.items) {
        return [generateValue(prop.items)];
      }
      return [];
    case "object":
      if (prop.properties) {
        return generateSampleArgs(prop);
      }
      return {};
    default:
      return "test";
  }
}
