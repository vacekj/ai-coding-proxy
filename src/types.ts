export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AnthropicMessageRequest {
  model?: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  thinking?: {
    type?: string;
    budget_tokens?: number;
  };
  output_config?: {
    effort?: string;
  };
}

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "thinking"; thinking?: string; text?: string; signature?: string; [key: string]: unknown }
  | { type: "image"; source?: AnthropicImageSource; [key: string]: unknown }
  | { type: "tool_use"; id: string; name: string; input?: unknown; [key: string]: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface AnthropicImageSource {
  type?: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export type AnthropicToolChoice =
  | "auto"
  | "any"
  | "none"
  | { type: "auto" | "any" | "tool" | "none"; name?: string; disable_parallel_tool_use?: boolean };

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: {
    effort?: string;
    summary?: "auto" | "concise" | "detailed";
  };
  parallel_tool_calls?: boolean;
  stream: true;
  store: false;
  include?: string[];
  stop?: string[];
  prompt_cache_key?: string;
  text?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: ResponsesContentPart[];
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | ResponsesContentPart[];
    }
  | {
      type: "reasoning";
      encrypted_content?: string;
      summary?: unknown[];
      content?: null;
    };

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export interface ResponsesTool {
  type: "function" | "web_search";
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  [key: string]: unknown;
}

export interface XAIStreamEvent {
  type?: string;
  response?: XAIResponse;
  item?: XAIOutputItem;
  delta?: string;
  arguments?: string;
  output_index?: number;
  [key: string]: unknown;
}

export interface XAIResponse {
  id?: string;
  model?: string;
  output?: XAIOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
  stop_reason?: string;
  incomplete_details?: {
    reason?: string;
  };
  stop_sequence?: string | null;
  [key: string]: unknown;
}

export type XAIOutputItem =
  | {
      type: "message";
      id?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string; [key: string]: unknown }> | string;
      [key: string]: unknown;
    }
  | {
      type: "function_call";
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      status?: string;
      [key: string]: unknown;
    }
  | {
      type: "reasoning";
      id?: string;
      encrypted_content?: string;
      summary?: unknown;
      content?: unknown;
      [key: string]: unknown;
    }
  | {
      type?: string;
      [key: string]: unknown;
    };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream: false;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: unknown;
  effort?: string;
  reasoning_effort?: string;
  [key: string]: unknown;
}

export type OpenAIChatMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string | Array<Record<string, unknown>> | null;
      tool_calls?: OpenAIChatToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface OpenAIChatToolCall {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
  index?: number;
}

export interface OpenAIChatCompletion {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | Array<Record<string, unknown>> | null;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: OpenAIChatToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_creation?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

export interface OAuthTokenFile {
  type: "xai";
  auth_kind: "oauth";
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  expired?: string;
  token_endpoint?: string;
  base_url?: string;
  email?: string;
  sub?: string;
  last_refresh?: string;
}

export interface GrokCliAuthEntry {
  key?: string;
  auth_mode?: string;
  create_time?: string;
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  principal_type?: string;
  principal_id?: string;
  team_id?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  [key: string]: unknown;
}

export type GrokCliAuthFile = Record<string, GrokCliAuthEntry>;
