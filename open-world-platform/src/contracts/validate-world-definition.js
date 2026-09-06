import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../contracts/world-definition.schema.json' with { type: 'json' };

// Structural rules have one source shared with the map creator. Filesystem and
// catalog-reference checks remain in loadWorldDefinition.
const validate = new Ajv2020({ allErrors: true }).compile(schema);

export function validateWorldDefinition(definition) {
  const valid = validate(definition);
  const errors = (validate.errors ?? []).map((error) => {
    const location = error.instancePath.slice(1).replaceAll('/', '.') || 'World Definition';
    const message = error.keyword === 'pattern' && error.schemaPath.includes('relativeJsonPath')
      ? 'must be a contained relative JSON path'
      : error.message;
    return `${location} ${message}${error.params.additionalProperty ? `: ${error.params.additionalProperty}` : ''}`;
  });
  return { valid, errors };
}

export function assertWorldDefinition(definition) {
  const result = validateWorldDefinition(definition);
  if (!result.valid) throw new Error(`Invalid World Definition:\n- ${result.errors.join('\n- ')}`);
  return definition;
}
