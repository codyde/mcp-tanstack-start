import type { z } from "zod";

/**
 * Internal type for accessing Zod's internal _def property.
 * This is not part of Zod's public API and may change between versions.
 */
interface ZodDefWithTypeName {
  typeName?: string;
  description?: string;
  shape?: () => Record<string, z.ZodType>;
  type?: z.ZodType;
  values?: string[];
  innerType?: z.ZodType;
  defaultValue?: () => unknown;
  value?: unknown;
  options?: z.ZodType[];
  valueType?: z.ZodType;
}

/**
 * Convert a Zod schema to JSON Schema format for MCP tool registration.
 *
 * This is a simplified converter that handles common Zod types.
 * For complex schemas, consider using zod-to-json-schema package.
 *
 * Note: This accesses Zod's internal `_def` property which is not part of the
 * public API. While this works with current Zod versions (3.x), it may break
 * in future major versions.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return convertZodToJsonSchema(schema);
}

function convertZodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = schema._def as ZodDefWithTypeName;
  const typeName = def?.typeName;

  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertZodToJsonSchema(value as z.ZodType);

        // Check if the field is optional
        const fieldDef = (value as z.ZodType)._def as ZodDefWithTypeName;
        if (fieldDef?.typeName !== "ZodOptional" && fieldDef?.typeName !== "ZodDefault") {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    case "ZodString": {
      const result: Record<string, unknown> = { type: "string" };
      if (def.description) result.description = def.description;
      return result;
    }

    case "ZodNumber": {
      const result: Record<string, unknown> = { type: "number" };
      if (def.description) result.description = def.description;
      return result;
    }

    case "ZodBoolean": {
      const result: Record<string, unknown> = { type: "boolean" };
      if (def.description) result.description = def.description;
      return result;
    }

    case "ZodArray": {
      const innerType = def.type;
      if (!innerType) return { type: "array" };
      return {
        type: "array",
        items: convertZodToJsonSchema(innerType),
      };
    }

    case "ZodEnum": {
      const values = def.values;
      return {
        type: "string",
        enum: values,
      };
    }

    case "ZodOptional": {
      const innerSchema = def.innerType;
      if (!innerSchema) return {};
      return convertZodToJsonSchema(innerSchema);
    }

    case "ZodDefault": {
      const innerSchema = def.innerType;
      if (!innerSchema) return {};
      const result = convertZodToJsonSchema(innerSchema);
      if (def.defaultValue) {
        result.default = def.defaultValue();
      }
      return result;
    }

    case "ZodNullable": {
      const innerSchema = def.innerType;
      if (!innerSchema) return { nullable: true };
      const inner = convertZodToJsonSchema(innerSchema);
      return {
        ...inner,
        nullable: true,
      };
    }

    case "ZodLiteral": {
      const value = def.value;
      return {
        type: typeof value,
        const: value,
      };
    }

    case "ZodUnion": {
      const options = def.options;
      if (!options) return {};
      return {
        oneOf: options.map((opt) => convertZodToJsonSchema(opt)),
      };
    }

    case "ZodRecord": {
      const valueType = def.valueType;
      if (!valueType) return { type: "object" };
      return {
        type: "object",
        additionalProperties: convertZodToJsonSchema(valueType),
      };
    }

    case "ZodAny":
      return {};

    case "ZodUnknown":
      return {};

    default:
      // Fallback for unsupported types
      return { type: "object" };
  }
}

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[Extract<keyof T, string>];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}
