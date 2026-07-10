import { describe, expect, it } from 'vitest';

import { workflowToolNames } from './models.js';
import { TOOL_SCHEMAS } from './schemas.js';

type JsonSchema = {
  type?: string | string[];
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
};

function visitObjectSchemas(schema: JsonSchema, callback: (schema: JsonSchema) => void) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) callback(schema);
  for (const child of Object.values(schema.properties ?? {})) visitObjectSchemas(child, callback);
  if (schema.items) visitObjectSchemas(schema.items, callback);
}

describe('deep research workflow tool schemas', () => {
  it('exports one strict function schema for every required workflow tool', () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...workflowToolNames].sort());

    for (const toolName of workflowToolNames) {
      const schema = TOOL_SCHEMAS[toolName];
      expect(schema).toMatchObject({
        type: 'function',
        name: toolName,
        strict: true,
      });
      expect(schema.parameters.type).toBe('object');
      expect(schema.parameters.additionalProperties).toBe(false);
      expect(schema.parameters.required).toBeDefined();
    }
  });

  it('sets additionalProperties false and explicit required fields for every object schema', () => {
    for (const schema of Object.values(TOOL_SCHEMAS)) {
      visitObjectSchemas(schema.parameters, (objectSchema) => {
        expect(objectSchema.additionalProperties).toBe(false);
        expect(objectSchema.required).toBeDefined();
        expect(new Set(objectSchema.required)).toEqual(new Set(Object.keys(objectSchema.properties ?? {})));
      });
    }
  });

  it('uses enums for constrained workflow fields', () => {
    const deliverable = TOOL_SCHEMAS.set_deliverable_contract.parameters.properties!;
    expect(deliverable.final_format.enum).toEqual(['html', 'pdf', 'markdown_handoff', 'other']);
    expect(deliverable.output_mode.enum).toEqual(['human_report', 'printable', 'skill_handoff']);
    expect(deliverable.depth.enum).toEqual(['brief', 'standard', 'deep']);

    const execution = TOOL_SCHEMAS.set_execution_mode.parameters.properties!;
    expect(execution.execution_mode.enum).toEqual(['subagents', 'sequential_passes', 'single_main_pass']);

    const complete = TOOL_SCHEMAS.complete_task.parameters.properties!;
    expect(complete.status.enum).toEqual(['done', 'blocked', 'skipped']);

    const conflict = TOOL_SCHEMAS.record_reconciliation.parameters.properties!.conflicts.items!.properties!;
    expect(conflict.confidence.enum).toEqual(['low', 'medium', 'high']);
  });
});
