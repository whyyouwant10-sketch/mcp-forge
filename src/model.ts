export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
  default?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minItems?: number;
  maxItems?: number;
  format?: string;
  [key: string]: unknown;
};

export type NormalizedParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: JsonSchema;
  description?: string;
};

export type NormalizedOperation = {
  name: string;
  originalOperationId?: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: NormalizedParameter[];
  requestBody?: {
    required: boolean;
    mediaType: "application/json" | "application/x-www-form-urlencoded";
    schema: JsonSchema;
  };
  response?: {
    status: string;
    mediaType?: "application/json" | "text/plain";
    schema?: JsonSchema;
  };
  security: string[][];
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  descriptionText: string;
};

export type NormalizedSpec = {
  openapi: string;
  title: string;
  version: string;
  projectName: string;
  serverUrl: string;
  operations: NormalizedOperation[];
  schemas: Record<string, JsonSchema>;
  securitySchemes: Record<string, SecurityScheme>;
  warnings: string[];
};

export type SecurityScheme = {
  type: "apiKey" | "http" | "unsupported";
  name?: string;
  in?: "header" | "query";
  scheme?: string;
};

export type GeneratorOptions = {
  projectName?: string;
  serverUrl?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  includeDeprecated?: boolean;
  strict?: boolean;
  force?: boolean;
};

export type Diagnostic = { pointer?: string; message: string };
