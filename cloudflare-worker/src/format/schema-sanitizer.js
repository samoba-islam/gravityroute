/**
 * Schema Sanitizer for Cloudflare Worker
 * Cleans and transforms JSON schemas for Gemini/Antigravity API compatibility
 */

function appendDescriptionHint(schema, hint) {
    if (!schema || typeof schema !== 'object') return schema;
    const result = { ...schema };
    result.description = result.description
        ? `${result.description} (${hint})`
        : hint;
    return result;
}

function scoreSchemaOption(schema) {
    if (!schema || typeof schema !== 'object') return 0;
    if (schema.type === 'object' || schema.properties) return 3;
    if (schema.type === 'array' || schema.items) return 2;
    if (schema.type && schema.type !== 'null') return 1;
    return 0;
}

function convertRefsToHints(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(convertRefsToHints);

    const result = { ...schema };

    if (result.$ref && typeof result.$ref === 'string') {
        const parts = result.$ref.split('/');
        const defName = parts[parts.length - 1] || 'unknown';
        const hint = `See: ${defName}`;
        const description = result.description
            ? `${result.description} (${hint})`
            : hint;
        return { type: 'object', description };
    }

    if (result.properties && typeof result.properties === 'object') {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            result.properties[key] = convertRefsToHints(value);
        }
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(convertRefsToHints);
        } else if (typeof result.items === 'object') {
            result.items = convertRefsToHints(result.items);
        }
    }

    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(result[key])) {
            result[key] = result[key].map(convertRefsToHints);
        }
    }

    return result;
}

function mergeAllOf(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(mergeAllOf);

    let result = { ...schema };

    if (Array.isArray(result.allOf) && result.allOf.length > 0) {
        const mergedProperties = {};
        const mergedRequired = new Set();
        const otherFields = {};

        for (const subSchema of result.allOf) {
            if (!subSchema || typeof subSchema !== 'object') continue;

            if (subSchema.properties) {
                for (const [key, value] of Object.entries(subSchema.properties)) {
                    mergedProperties[key] = value;
                }
            }

            if (Array.isArray(subSchema.required)) {
                for (const req of subSchema.required) {
                    mergedRequired.add(req);
                }
            }

            for (const [key, value] of Object.entries(subSchema)) {
                if (key !== 'properties' && key !== 'required' && !(key in otherFields)) {
                    otherFields[key] = value;
                }
            }
        }

        delete result.allOf;

        for (const [key, value] of Object.entries(otherFields)) {
            if (!(key in result)) {
                result[key] = value;
            }
        }

        if (Object.keys(mergedProperties).length > 0) {
            result.properties = { ...mergedProperties, ...(result.properties || {}) };
        }

        if (mergedRequired.size > 0) {
            const parentRequired = Array.isArray(result.required) ? result.required : [];
            result.required = [...new Set([...mergedRequired, ...parentRequired])];
        }
    }

    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = mergeAllOf(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(mergeAllOf);
        } else if (typeof result.items === 'object') {
            result.items = mergeAllOf(result.items);
        }
    }

    return result;
}

function flattenAnyOfOneOf(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(flattenAnyOfOneOf);

    let result = { ...schema };

    for (const unionKey of ['anyOf', 'oneOf']) {
        if (Array.isArray(result[unionKey]) && result[unionKey].length > 0) {
            const options = result[unionKey];
            const typeNames = [];
            let bestOption = null;
            let bestScore = -1;

            for (const option of options) {
                if (!option || typeof option !== 'object') continue;
                const typeName = option.type || (option.properties ? 'object' : null);
                if (typeName && typeName !== 'null') {
                    typeNames.push(typeName);
                }

                const score = scoreSchemaOption(option);
                if (score > bestScore) {
                    bestScore = score;
                    bestOption = option;
                }
            }

            delete result[unionKey];

            if (bestOption) {
                const parentDescription = result.description;
                const flattenedOption = flattenAnyOfOneOf(bestOption);

                for (const [key, value] of Object.entries(flattenedOption)) {
                    if (key === 'description') {
                        if (value && value !== parentDescription) {
                            result.description = parentDescription
                                ? `${parentDescription} (${value})`
                                : value;
                        }
                    } else if (!(key in result) || key === 'type' || key === 'properties' || key === 'items') {
                        result[key] = value;
                    }
                }

                if (typeNames.length > 1) {
                    const uniqueTypes = [...new Set(typeNames)];
                    result = appendDescriptionHint(result, `Accepts: ${uniqueTypes.join(' | ')}`);
                }
            }
        }
    }

    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = flattenAnyOfOneOf(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(flattenAnyOfOneOf);
        } else if (typeof result.items === 'object') {
            result.items = flattenAnyOfOneOf(result.items);
        }
    }

    return result;
}

function addEnumHints(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(addEnumHints);

    let result = { ...schema };

    if (Array.isArray(result.enum) && result.enum.length > 1 && result.enum.length <= 10) {
        const vals = result.enum.map(v => String(v)).join(', ');
        result = appendDescriptionHint(result, `Allowed: ${vals}`);
    }

    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = addEnumHints(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        result.items = Array.isArray(result.items)
            ? result.items.map(addEnumHints)
            : addEnumHints(result.items);
    }

    return result;
}

function addAdditionalPropertiesHints(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(addAdditionalPropertiesHints);

    let result = { ...schema };

    if (result.additionalProperties === false) {
        result = appendDescriptionHint(result, 'No extra properties allowed');
    }

    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = addAdditionalPropertiesHints(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        result.items = Array.isArray(result.items)
            ? result.items.map(addAdditionalPropertiesHints)
            : addAdditionalPropertiesHints(result.items);
    }

    return result;
}

function moveConstraintsToDescription(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(moveConstraintsToDescription);

    const CONSTRAINTS = ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'format'];
    let result = { ...schema };

    for (const constraint of CONSTRAINTS) {
        if (result[constraint] !== undefined && typeof result[constraint] !== 'object') {
            result = appendDescriptionHint(result, `${constraint}: ${result[constraint]}`);
        }
    }

    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = moveConstraintsToDescription(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        result.items = Array.isArray(result.items)
            ? result.items.map(moveConstraintsToDescription)
            : moveConstraintsToDescription(result.items);
    }

    return result;
}

function flattenTypeArrays(schema, nullableProps = null, currentPropName = null) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => flattenTypeArrays(s, nullableProps));

    let result = { ...schema };

    if (Array.isArray(result.type)) {
        const types = result.type;
        const hasNull = types.includes('null');
        const nonNullTypes = types.filter(t => t !== 'null' && t);
        const firstType = nonNullTypes.length > 0 ? nonNullTypes[0] : 'string';
        result.type = firstType;

        if (nonNullTypes.length > 1) {
            result = appendDescriptionHint(result, `Accepts: ${nonNullTypes.join(' | ')}`);
        }

        if (hasNull) {
            result = appendDescriptionHint(result, 'nullable');
            if (nullableProps && currentPropName) {
                nullableProps.add(currentPropName);
            }
        }
    }

    if (result.properties && typeof result.properties === 'object') {
        const childNullableProps = new Set();
        const newProps = {};

        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = flattenTypeArrays(value, childNullableProps, key);
        }
        result.properties = newProps;

        if (Array.isArray(result.required) && childNullableProps.size > 0) {
            result.required = result.required.filter(prop => !childNullableProps.has(prop));
            if (result.required.length === 0) {
                delete result.required;
            }
        }
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(item => flattenTypeArrays(item, nullableProps));
        } else if (typeof result.items === 'object') {
            result.items = flattenTypeArrays(result.items, nullableProps);
        }
    }

    return result;
}

export function sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return {
            type: 'object',
            properties: {
                reason: {
                    type: 'string',
                    description: 'Reason for calling this tool'
                }
            },
            required: ['reason']
        };
    }

    const ALLOWED_FIELDS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'title']);
    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        if (key === 'const') {
            sanitized.enum = [value];
            continue;
        }
        if (!ALLOWED_FIELDS.has(key)) {
            continue;
        }

        if (key === 'properties' && value && typeof value === 'object') {
            sanitized.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                sanitized.properties[propKey] = sanitizeSchema(propValue);
            }
        } else if (key === 'items' && value && typeof value === 'object') {
            if (Array.isArray(value)) {
                sanitized.items = value.map(item => sanitizeSchema(item));
            } else {
                sanitized.items = sanitizeSchema(value);
            }
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            sanitized[key] = sanitizeSchema(value);
        } else {
            sanitized[key] = value;
        }
    }

    if (!sanitized.type) {
        sanitized.type = 'object';
    }

    if (sanitized.type === 'object' && (!sanitized.properties || Object.keys(sanitized.properties).length === 0)) {
        sanitized.properties = {
            reason: {
                type: 'string',
                description: 'Reason for calling this tool'
            }
        };
        sanitized.required = ['reason'];
    }

    return sanitized;
}

function toGoogleType(type) {
    if (!type || typeof type !== 'string') return type;
    const typeMap = {
        'string': 'STRING',
        'number': 'NUMBER',
        'integer': 'INTEGER',
        'boolean': 'BOOLEAN',
        'array': 'ARRAY',
        'object': 'OBJECT',
        'null': 'STRING'
    };
    return typeMap[type.toLowerCase()] || type.toUpperCase();
}

export function cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(cleanSchema);

    let result = convertRefsToHints(schema);
    result = addEnumHints(result);
    result = addAdditionalPropertiesHints(result);
    result = moveConstraintsToDescription(result);
    result = mergeAllOf(result);
    result = flattenAnyOfOneOf(result);
    result = flattenTypeArrays(result);

    const unsupported = [
        'additionalProperties', 'default', '$schema', '$defs',
        'definitions', '$ref', '$id', '$comment', 'title',
        'minLength', 'maxLength', 'pattern', 'format',
        'minItems', 'maxItems', 'examples', 'allOf', 'anyOf', 'oneOf'
    ];

    for (const key of unsupported) {
        delete result[key];
    }

    if (result.type === 'string' && result.format) {
        const allowed = ['enum', 'date-time'];
        if (!allowed.includes(result.format)) {
            delete result.format;
        }
    }

    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = cleanSchema(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(cleanSchema);
        } else if (typeof result.items === 'object') {
            result.items = cleanSchema(result.items);
        }
    }

    if (result.required && Array.isArray(result.required) && result.properties) {
        const definedProps = new Set(Object.keys(result.properties));
        result.required = result.required.filter(prop => definedProps.has(prop));
        if (result.required.length === 0) {
            delete result.required;
        }
    }

    if (result.type && typeof result.type === 'string') {
        result.type = toGoogleType(result.type);
    }

    if (result.type === 'ARRAY') {
        if (!result.items || typeof result.items !== 'object') {
            result.items = { type: 'STRING' };
        } else if (Array.isArray(result.items)) {
            let best = null;
            let bestScore = -1;
            for (const option of result.items) {
                const score = scoreSchemaOption(option);
                if (score > bestScore) {
                    bestScore = score;
                    best = option;
                }
            }
            result.items = best || { type: 'STRING' };
        }
    }

    if (result.type !== 'OBJECT') {
        delete result.properties;
        delete result.required;
    }

    return result;
}
