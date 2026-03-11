// Simple MCP server implementation without agents/mcp framework
import type { ExecutionContext } from '@cloudflare/workers-types';
import toolsConfigRaw from "./config/tools.config.json";
import type { McpFromApiConfig, ToolConfig } from "./config/types";

const toolsConfig = toolsConfigRaw as McpFromApiConfig;

const toolRegistry: Map<string, ToolConfig> = new Map(
	toolsConfig.tools.map((tool) => [tool.name, tool]),
);

function getBearerToken(request: Request): string | undefined {
	const auth = request.headers.get("Authorization");
	if (!auth || !/^Bearer\s+/i.test(auth)) return undefined;
	return auth.replace(/^Bearer\s+/i, "").trim() || undefined;
}

function buildUrlWithQuery(baseUrl: string, path: string, queryConfig: Record<string, string> | undefined, args: Record<string, unknown>): string {
	// Append path to base URL so base path is preserved (new URL(path, base) would replace base path)
	const base = baseUrl.replace(/\/$/, "");
	const pathPart = path.startsWith("/") ? path : `/${path}`;
	const url = new URL(`${base}${pathPart}`);
	if (queryConfig) {
		const params = new URLSearchParams(url.search);
		for (const [queryKey, argKey] of Object.entries(queryConfig)) {
			const value = args[argKey];
			if (value !== undefined && value !== null) {
				params.set(queryKey, String(value));
			}
		}
		url.search = params.toString();
	}
	return url.toString();
}

function buildJsonBody(bodyConfig: ToolConfig["http"]["body"], args: Record<string, unknown>): string | undefined {
	if (!bodyConfig) return undefined;
	if (bodyConfig.mode !== "json") return undefined;

	if (bodyConfig.mapping === "full") {
		return JSON.stringify(args);
	}

	if (bodyConfig.mapping === "properties" && bodyConfig.properties) {
		const mapped: Record<string, unknown> = {};
		for (const [propName, argKey] of Object.entries(bodyConfig.properties)) {
			if (argKey in args) {
				mapped[propName] = args[argKey];
			}
		}
		return JSON.stringify(mapped);
	}

	return undefined;
}

async function callConfiguredTool(tool: ToolConfig, args: Record<string, unknown>, env: Env, token?: string): Promise<string> {
	const baseUrlKey = toolsConfig.baseUrlEnvKey;
	const baseUrl = (env as unknown as Record<string, string | undefined>)[baseUrlKey];

	if (!baseUrl) {
		throw new Error(`Missing base URL in env for key ${baseUrlKey}`);
	}

	const { http, response } = tool;
	const url = buildUrlWithQuery(baseUrl, http.path, http.query, args);

	const headers = new Headers();
	if (http.headers) {
		for (const [key, value] of Object.entries(http.headers)) {
			headers.set(key, value);
		}
	}

	if (token && !headers.has("Authorization")) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	const body = buildJsonBody(http.body, args);

	const upstreamTimeoutMs = 30_000;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), upstreamTimeoutMs);

	let resp: Response;
	try {
		console.log("Calling upstream tool", {
			toolName: tool.name,
			method: http.method,
			url,
			headers: Object.fromEntries(headers.entries()),
			body,
		});
		resp = await fetch(url, {
			method: http.method,
			headers,
			body,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timeoutId);
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(
				`Upstream API (${tool.name}) did not respond within ${upstreamTimeoutMs / 1000}s. The Yoonik/Retool endpoint may be slow or overloaded.`,
			);
		}
		throw err;
	}
	clearTimeout(timeoutId);

	if (!resp.ok) {
		throw new Error(`HTTP error calling ${tool.name}: ${resp.status} ${resp.statusText}`);
	}

	let rawText: string;
	if (response.mode === "json") {
		const json = await resp.json();
		let selected: unknown = json;
		if (response.contentPath) {
			const segments = response.contentPath.split(".");
			for (const segment of segments) {
				if (selected && typeof selected === "object" && segment in selected) {
					// @ts-expect-error index access
					selected = selected[segment];
				} else {
					selected = undefined;
					break;
				}
			}
		}
		rawText = JSON.stringify(selected ?? json, null, 2);
	} else {
		rawText = await resp.text();
	}

	if (response.wrap && response.wrap.type === "text") {
		return response.wrap.template.replace("{{body}}", rawText);
	}

	return rawText;
}

class SimpleMCPServer {
	async handleRequest(request: Request, env: Env, token?: string): Promise<Response> {
		try {
			const body = await request.json() as any;
			
			// Handle initialize request
			if (body.method === "initialize") {
				console.log('Sending initialize response with capabilities');
				const initResponse = {
					jsonrpc: "2.0",
					result: {
						protocolVersion: "2024-11-05",
						capabilities: {
							tools: {},
							prompts: {},
							resources: {}
						},
						serverInfo: {
							name: toolsConfig.server.name,
							version: toolsConfig.server.version
						}
					},
					id: body.id
				};
				
				console.log('Initialize response:', JSON.stringify(initResponse, null, 2));
				
				return new Response(JSON.stringify(initResponse), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*"
					}
				});
			}
			
			// Handle notifications (no response needed)
			if (body.method === "notifications/initialized") {
				console.log('Received notifications/initialized - MCP handshake complete');
				
				return new Response("", {
					status: 202, // CRITICAL: Must be 202, not 200!
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*"
					}
				});
			}
			
			// Handle list_tools request
			if (body.method === "tools/list") {
				console.log('Handling tools/list request');
				const toolsResponse = {
					jsonrpc: "2.0",
					result: {
						tools: toolsConfig.tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					},
					id: body.id
				};
				
				console.log('Tools list response:', JSON.stringify(toolsResponse, null, 2));
				
				return new Response(JSON.stringify(toolsResponse), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*"
					}
				});
			}
			
			// Handle prompts/list request
			if (body.method === "prompts/list") {
				console.log('Handling prompts/list request');
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					result: {
						prompts: []
					},
					id: body.id
				}), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*"
					}
				});
			}
			
			// Handle resources/list request
			if (body.method === "resources/list") {
				console.log('Handling resources/list request');
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					result: {
						resources: []
					},
					id: body.id
				}), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*"
					}
				});
			}
			
			// Handle call_tool request
			if (body.method === "tools/call") {
				const { name, arguments: args } = body.params;
				console.log("Received tools/call request", {
					name,
					rawParams: body.params,
					argsType: typeof args,
					args,
				});
				const tool = toolRegistry.get(name);

				if (!tool) {
					return new Response(JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32601,
							message: `Unknown tool: ${name}`,
						},
						id: body.id,
					}), {
						status: 400,
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
						},
					});
				}

				// Basic validation using the tool's input schema so the LLM
				// gets a clear, structured error instead of silently calling
				// the upstream API with an empty payload.
				const inputSchema = tool.inputSchema as any;
				const requiredKeys: string[] = Array.isArray(inputSchema?.required)
					? inputSchema.required
					: [];
				const argsObj: Record<string, unknown> =
					args && typeof args === "object" ? (args as Record<string, unknown>) : {};
				const missingRequired = requiredKeys.filter((key) => argsObj[key] === undefined);

				if (missingRequired.length > 0) {
					const message = `Missing required argument(s) for tool "${name}": ${missingRequired.join(
						", ",
					)}. Please provide them in the "arguments" object.`;
					console.warn(message, { requiredKeys, receivedArgs: argsObj });

					return new Response(JSON.stringify({
						jsonrpc: "2.0",
						result: {
							content: [
								{
									type: "text",
									text: message,
								},
							],
							isError: true,
						},
						id: body.id,
					}), {
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
						},
					});
				}

				try {
					const resultContent = await callConfiguredTool(tool, args ?? {}, env, token);

					return new Response(JSON.stringify({
						jsonrpc: "2.0",
						result: {
							content: [
								{
									type: "text",
									text: resultContent,
								},
							],
						},
						id: body.id,
					}), {
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
						},
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unknown error";
					return new Response(JSON.stringify({
						jsonrpc: "2.0",
						result: {
							content: [
								{
									type: "text",
									text: `Tool execution error for ${name}: ${message}`,
								},
							],
							isError: true,
						},
						id: body.id,
					}), {
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
						},
					});
				}
			}
			
			// Unknown method
			console.log(`Unknown method received: ${body.method}`, JSON.stringify(body, null, 2));
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32601,
					message: `Unknown method: ${body.method}`
				},
				id: body.id
			}), {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*"
				}
			});
			
		} catch (error) {
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32700,
					message: "Parse error"
				},
				id: null
			}), {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*"
				}
			});
		}
	}
}

const mcpServer = new SimpleMCPServer();

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Handle MCP requests (both /sse and /mcp endpoints with optional token)
		// Use (.*) and optional trailing slash so /sse, /sse/, and /sse/TOKEN all match (url+headers config uses /sse/)
		const sseMatch = url.pathname.match(/^\/sse(?:\/(.*))?\/?$/);
		const mcpMatch = url.pathname.match(/^\/mcp(?:\/(.*))?\/?$/);
		
		if (sseMatch || mcpMatch) {
			const rawPathToken = sseMatch ? sseMatch[1] : mcpMatch?.[1];
			const pathToken =
				typeof rawPathToken === "string" && rawPathToken.trim()
					? rawPathToken.trim()
					: undefined;
			const token = pathToken ?? getBearerToken(request);
			
			if (request.method === "POST") {
				return mcpServer.handleRequest(request, env, token);
			}
			
			// For GET requests, return a simple response
			if (request.method === "GET") {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					result: {
						protocolVersion: "2024-11-05",
						capabilities: {
							tools: {},
							prompts: {},
							resources: {},
						},
						serverInfo: {
							name: toolsConfig.server.name,
							version: toolsConfig.server.version,
						},
					},
				}), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					},
				});
			}
		}

		// Add a simple health check endpoint
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({
				status: "healthy",
				name: toolsConfig.server.name,
				version: toolsConfig.server.version,
				tools: toolsConfig.tools.map((tool) => tool.name),
				endpoints: {
					mcp: "/mcp[/TOKEN]",
					sse: "/sse[/TOKEN]",
					health: "/health",
				},
				serverInitialized: true,
				timestamp: new Date().toISOString(),
			}), {
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			});
		}

		// Handle OPTIONS requests for CORS
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 200,
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization"
				}
			});
		}

		return new Response("Not found", { status: 404 });
	},
};
