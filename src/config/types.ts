export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ToolHttpBodyConfig {
	mode: "json";
	/**
	 * How to map MCP arguments into the HTTP body when mode === "json".
	 * - "full": send the full args object as the JSON body
	 * - "properties": only send a subset of properties defined in `properties` map
	 */
	mapping: "full" | "properties";
	properties?: Record<string, string>;
}

export interface ToolHttpConfig {
	method: HttpMethod;
	path: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: ToolHttpBodyConfig;
}

export interface ToolResponseWrapConfig {
	type: "text";
	/**
	 * Simple template string for wrapping the response body.
	 * Currently only supports replacing `{{body}}` with the stringified response.
	 */
	template: string;
}

export interface ToolResponseConfig {
	mode: "json" | "text";
	/**
	 * Optional JSON path or dotted path into the parsed JSON body.
	 * For now this is treated as a simple dotted path (e.g. "data.items").
	 */
	contentPath?: string | null;
	wrap?: ToolResponseWrapConfig;
}

export interface ToolConfig {
	name: string;
	description: string;
	inputSchema: unknown;
	http: ToolHttpConfig;
	response: ToolResponseConfig;
}

export interface ServerMetadataConfig {
	name: string;
	version: string;
	description?: string;
}

export interface McpFromApiConfig {
	server: ServerMetadataConfig;
	baseUrlEnvKey: string;
	tools: ToolConfig[];
}
