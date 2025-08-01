import { tasks } from '@trigger.dev/sdk/v3'
import { and, eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import {
  handleSlackChallenge,
  handleWhatsAppVerification,
  validateMicrosoftTeamsSignature,
} from '@/lib/webhooks/utils'
import { db } from '@/db'
import { subscription, webhook, workflow } from '@/db/schema'
import { RateLimiter } from '@/services/queue'
import type { SubscriptionPlan } from '@/services/queue/types'

const logger = createLogger('WebhookTriggerAPI')

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Webhook Verification Handler (GET)
 *
 * Handles verification requests from webhook providers and confirms endpoint exists.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string }> }) {
  const requestId = crypto.randomUUID().slice(0, 8)

  try {
    const path = (await params).path
    const url = new URL(request.url)

    // Handle WhatsApp specific verification challenge
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    const whatsAppResponse = await handleWhatsAppVerification(
      requestId,
      path,
      mode,
      token,
      challenge
    )
    if (whatsAppResponse) {
      return whatsAppResponse
    }

    // Verify webhook exists in database
    const webhooks = await db
      .select({
        webhook: webhook,
      })
      .from(webhook)
      .where(and(eq(webhook.path, path), eq(webhook.isActive, true)))
      .limit(1)

    if (webhooks.length === 0) {
      logger.warn(`[${requestId}] No active webhook found for path: ${path}`)
      return new NextResponse('Webhook not found', { status: 404 })
    }

    logger.info(`[${requestId}] Webhook verification successful for path: ${path}`)
    return new NextResponse('OK', { status: 200 })
  } catch (error: any) {
    logger.error(`[${requestId}] Error processing webhook verification`, error)
    return new NextResponse(`Internal Server Error: ${error.message}`, {
      status: 500,
    })
  }
}

/**
 * Webhook Payload Handler (POST)
 *
 * Processes incoming webhook payloads from all supported providers.
 * Fast acknowledgment with async processing for most providers except Airtable.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string }> }
) {
  const requestId = crypto.randomUUID().slice(0, 8)
  let foundWorkflow: any = null
  let foundWebhook: any = null

  // --- PHASE 1: Request validation and parsing ---
  let rawBody: string | null = null
  try {
    const requestClone = request.clone()
    rawBody = await requestClone.text()

    if (!rawBody || rawBody.length === 0) {
      logger.warn(`[${requestId}] Rejecting request with empty body`)
      return new NextResponse('Empty request body', { status: 400 })
    }
  } catch (bodyError) {
    logger.error(`[${requestId}] Failed to read request body`, {
      error: bodyError instanceof Error ? bodyError.message : String(bodyError),
    })
    return new NextResponse('Failed to read request body', { status: 400 })
  }

  // Parse the body as JSON
  let body: any
  try {
    body = JSON.parse(rawBody)

    if (Object.keys(body).length === 0) {
      logger.warn(`[${requestId}] Rejecting empty JSON object`)
      return new NextResponse('Empty JSON payload', { status: 400 })
    }
  } catch (parseError) {
    logger.error(`[${requestId}] Failed to parse JSON body`, {
      error: parseError instanceof Error ? parseError.message : String(parseError),
    })
    return new NextResponse('Invalid JSON payload', { status: 400 })
  }

  // Handle Slack challenge
  const slackResponse = handleSlackChallenge(body)
  if (slackResponse) {
    return slackResponse
  }

  // --- PHASE 2: Webhook identification ---
  const path = (await params).path
  logger.info(`[${requestId}] Processing webhook request for path: ${path}`)

  // Find webhook and associated workflow
  const webhooks = await db
    .select({
      webhook: webhook,
      workflow: workflow,
    })
    .from(webhook)
    .innerJoin(workflow, eq(webhook.workflowId, workflow.id))
    .where(and(eq(webhook.path, path), eq(webhook.isActive, true)))
    .limit(1)

  if (webhooks.length === 0) {
    logger.warn(`[${requestId}] No active webhook found for path: ${path}`)
    return new NextResponse('Webhook not found', { status: 404 })
  }

  foundWebhook = webhooks[0].webhook
  foundWorkflow = webhooks[0].workflow

  // Handle Microsoft Teams signature verification if needed
  if (foundWebhook.provider === 'microsoftteams') {
    const providerConfig = (foundWebhook.providerConfig as Record<string, any>) || {}

    if (providerConfig.hmacSecret) {
      const authHeader = request.headers.get('authorization')

      if (!authHeader || !authHeader.startsWith('HMAC ')) {
        logger.warn(
          `[${requestId}] Microsoft Teams outgoing webhook missing HMAC authorization header`
        )
        return new NextResponse('Unauthorized - Missing HMAC signature', { status: 401 })
      }

      const isValidSignature = validateMicrosoftTeamsSignature(
        providerConfig.hmacSecret,
        authHeader,
        rawBody
      )

      if (!isValidSignature) {
        logger.warn(`[${requestId}] Microsoft Teams HMAC signature verification failed`)
        return new NextResponse('Unauthorized - Invalid HMAC signature', { status: 401 })
      }

      logger.debug(`[${requestId}] Microsoft Teams HMAC signature verified successfully`)
    }
  }

  // --- PHASE 3: Rate limiting for webhook execution ---
  try {
    // Get user subscription for rate limiting
    const [subscriptionRecord] = await db
      .select({ plan: subscription.plan })
      .from(subscription)
      .where(eq(subscription.referenceId, foundWorkflow.userId))
      .limit(1)

    const subscriptionPlan = (subscriptionRecord?.plan || 'free') as SubscriptionPlan

    // Check async rate limits (webhooks are processed asynchronously)
    const rateLimiter = new RateLimiter()
    const rateLimitCheck = await rateLimiter.checkRateLimit(
      foundWorkflow.userId,
      subscriptionPlan,
      'webhook',
      true // isAsync = true for webhook execution
    )

    if (!rateLimitCheck.allowed) {
      logger.warn(`[${requestId}] Rate limit exceeded for webhook user ${foundWorkflow.userId}`, {
        provider: foundWebhook.provider,
        remaining: rateLimitCheck.remaining,
        resetAt: rateLimitCheck.resetAt,
      })

      // Return 200 to prevent webhook provider retries, but indicate rate limit
      if (foundWebhook.provider === 'microsoftteams') {
        // Microsoft Teams requires specific response format
        return NextResponse.json({
          type: 'message',
          text: 'Rate limit exceeded. Please try again later.',
        })
      }

      // Simple error response for other providers (return 200 to prevent retries)
      return NextResponse.json({ message: 'Rate limit exceeded' }, { status: 200 })
    }

    logger.debug(`[${requestId}] Rate limit check passed for webhook`, {
      provider: foundWebhook.provider,
      remaining: rateLimitCheck.remaining,
      resetAt: rateLimitCheck.resetAt,
    })
  } catch (rateLimitError) {
    logger.error(`[${requestId}] Error checking webhook rate limits:`, rateLimitError)
    // Continue processing - better to risk rate limit bypass than fail webhook
  }

  // --- PHASE 4: Queue webhook execution via trigger.dev ---
  try {
    // Queue the webhook execution task
    const handle = await tasks.trigger('webhook-execution', {
      webhookId: foundWebhook.id,
      workflowId: foundWorkflow.id,
      userId: foundWorkflow.userId,
      provider: foundWebhook.provider,
      body,
      headers: Object.fromEntries(request.headers.entries()),
      path,
      blockId: foundWebhook.blockId,
    })

    logger.info(
      `[${requestId}] Queued webhook execution task ${handle.id} for ${foundWebhook.provider} webhook`
    )

    // Return immediate acknowledgment with provider-specific format
    if (foundWebhook.provider === 'microsoftteams') {
      // Microsoft Teams requires specific response format
      return NextResponse.json({
        type: 'message',
        text: 'Sim',
      })
    }

    return NextResponse.json({ message: 'Webhook processed' })
  } catch (error: any) {
    logger.error(`[${requestId}] Failed to queue webhook execution:`, error)

    // Still return 200 to prevent webhook provider retries
    if (foundWebhook.provider === 'microsoftteams') {
      // Microsoft Teams requires specific response format
      return NextResponse.json({
        type: 'message',
        text: 'Webhook processing failed',
      })
    }

    return NextResponse.json({ message: 'Internal server error' }, { status: 200 })
  }
}
