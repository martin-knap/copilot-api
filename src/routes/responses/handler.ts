import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  logger.debug("Responses request payload:", JSON.stringify(payload))

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)

  useFunctionApplyPatch(payload)

  // Remove web_search tool as it's not supported by GitHub Copilot
  removeWebSearchTool(payload)

  compactInputByLatestCompaction(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  // Handle text_format (structured output) — convert JSON schema to instructions
  // OpenAI SDK's responses.parse() sends text_format with JSON schema,
  // but Copilot API doesn't support it natively
  convertTextFormatToInstructions(payload)

  logger.debug("Translated Responses payload:", JSON.stringify(payload))

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, {
    vision,
    initiator,
    requestId,
    sessionId: sessionId,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()

      for await (const chunk of response) {
        logger.debug("Responses stream chunk:", JSON.stringify(chunk))

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }
    })
  }

  logger.debug(
    "Forwarding native Responses result:",
    JSON.stringify(response).slice(-400),
  )
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type === "custom" && t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

/**
 * Convert text_format (structured output / JSON schema) to instructions.
 *
 * OpenAI SDK's `responses.parse()` sends a `text_format` field with a JSON schema
 * so the model returns structured output. Copilot API does not support `text_format`,
 * so we inject the schema into `instructions` and remove the unsupported field.
 *
 * Also handles `text.format` (nested variant used by some SDK versions).
 */
const convertTextFormatToInstructions = (payload: ResponsesPayload): void => {
  // Handle top-level text_format (sent by responses.parse())
  const textFormat = (payload as Record<string, unknown>).text_format as
    | Record<string, unknown>
    | undefined
  if (textFormat) {
    const schemaInstruction = buildSchemaInstruction(textFormat)
    if (schemaInstruction) {
      payload.instructions =
        payload.instructions ?
          `${payload.instructions}\n\n${schemaInstruction}`
        : schemaInstruction
      logger.debug(
        "Converted text_format to instructions for structured output",
      )
    }
    delete (payload as Record<string, unknown>).text_format
  }

  // Handle nested text.format
  const textObj = (payload as Record<string, unknown>).text as
    | { format?: Record<string, unknown> }
    | undefined
  if (textObj?.format && textObj.format.type !== "text") {
    const schemaInstruction = buildSchemaInstruction(textObj.format)
    if (schemaInstruction) {
      payload.instructions =
        payload.instructions ?
          `${payload.instructions}\n\n${schemaInstruction}`
        : schemaInstruction
      logger.debug(
        "Converted text.format to instructions for structured output",
      )
    }
    // Reset to plain text
    ;(payload as Record<string, unknown>).text = { format: { type: "text" } }
  }

  // Remove max_output_tokens if present (unsupported by some Copilot models)
  if ((payload as Record<string, unknown>).max_output_tokens) {
    delete (payload as Record<string, unknown>).max_output_tokens
  }
}

const buildSchemaInstruction = (
  format: Record<string, unknown>,
): string | null => {
  const formatName = typeof format.name === "string" ? format.name : ""
  if (format.type === "json_schema" && format.schema) {
    const label = formatName ? ` (${formatName})` : ""
    return `You MUST respond with valid JSON matching this schema${label}:\n${JSON.stringify(format.schema, null, 2)}`
  }
  if (format.type === "json_object") {
    return "You MUST respond with valid JSON."
  }
  // parse() sometimes sends {name, schema} without type
  if (formatName && format.schema) {
    return `You MUST respond with valid JSON matching this schema (${formatName}):\n${JSON.stringify(format.schema, null, 2)}`
  }
  return null
}
