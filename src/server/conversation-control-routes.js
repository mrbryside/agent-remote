import { json, readJson } from './http.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

function boundedAnswerMap(value, { required = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return !required && value === undefined;
  const entries = Object.entries(value);
  if ((required && entries.length === 0) || entries.length > 20) return false;
  return entries.every(([prompt, answer]) =>
    prompt && prompt.length <= 4_000 && typeof answer === 'string' &&
    (!required || Boolean(answer)) && answer.length <= 4_000);
}

export function createConversationControlRouteHandler({
  conversationSession,
  registry,
  conversationFailure,
}) {
  async function managedSession(response, encodedName) {
    const session = await conversationSession(decodeURIComponent(encodedName));
    if (!session) json(response, 404, { error: 'Managed session not found' });
    return session;
  }

  return async function handleConversationControlRoute({ request, response, pathname }) {
    const modelMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/model$/);
    if (request.method === 'POST' && modelMatch) {
      const body = await readJson(request);
      if (typeof body.modelId !== 'string' || !identifierPattern.test(body.modelId)) {
        json(response, 400, { error: 'modelId must be a valid model identifier under 80 characters' });
        return true;
      }
      if (body.effortId !== undefined && (typeof body.effortId !== 'string' || !identifierPattern.test(body.effortId))) {
        json(response, 400, { error: 'effortId must be a valid effort identifier under 80 characters' });
        return true;
      }
      const session = await managedSession(response, modelMatch[1]);
      if (!session) return true;
      try {
        const result = await registry.setModel(session, body.modelId, body.effortId);
        json(response, 202, {
          accepted: true,
          modelId: result?.modelId || body.modelId,
          ...((result?.effortId || body.effortId) ? { effortId: result?.effortId || body.effortId } : {}),
          ...(result?.pending === true ? { pending: true } : {}),
        });
      } catch (error) {
        if (error?.code === 'GROK_ACP_MODEL_INVALID') json(response, 400, { error: error.message, code: error.code });
        else conversationFailure(response, error);
      }
      return true;
    }

    const modeMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/mode$/);
    if (request.method === 'POST' && modeMatch) {
      const body = await readJson(request);
      if (!['normal', 'plan', 'auto', 'alwaysApprove'].includes(body.modeId)) {
        json(response, 400, { error: 'modeId must be normal, plan, auto, or alwaysApprove' });
        return true;
      }
      const session = await managedSession(response, modeMatch[1]);
      if (!session) return true;
      try { json(response, 202, await registry.setMode(session, body.modeId)); }
      catch (error) {
        if (error?.code === 'GROK_ACP_MODE_INVALID') json(response, 400, { error: error.message, code: error.code });
        else if (error?.code === 'GROK_ACP_SESSION_BUSY') json(response, 409, { error: error.message, code: error.code });
        else conversationFailure(response, error);
      }
      return true;
    }

    const goalMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/);
    if (request.method === 'POST' && goalMatch) {
      const body = await readJson(request);
      if (!['pause', 'resume', 'clear'].includes(body.action)) {
        json(response, 400, { error: 'action must be pause, resume, or clear' });
        return true;
      }
      const session = await managedSession(response, goalMatch[1]);
      if (!session) return true;
      try {
        json(response, 202, { accepted: true, action: body.action, ...(await registry.controlGoal(session, body.action)) });
      } catch (error) { conversationFailure(response, error); }
      return true;
    }

    const questionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/question$/);
    if (request.method === 'POST' && questionMatch) {
      const body = await readJson(request);
      const accepted = body.outcome === undefined || body.outcome === 'accepted';
      if (typeof body.threadId !== 'string' || !body.threadId || body.threadId.length > 160 ||
          typeof body.questionId !== 'string' || !body.questionId || body.questionId.length > 160 ||
          (body.outcome !== undefined && !['accepted', 'skip_interview'].includes(body.outcome))) {
        json(response, 400, {
          error: 'threadId and questionId must be non-empty strings; outcome must be accepted or skip_interview',
        });
        return true;
      }
      if (!boundedAnswerMap(body.answers, { required: accepted })) {
        json(response, 400, { error: accepted
          ? 'accepted questions require bounded string answers'
          : 'answers must be a bounded string map' });
        return true;
      }
      const session = await managedSession(response, questionMatch[1]);
      if (!session) return true;
      try {
        await registry.respondQuestion(session, {
          threadId: body.threadId,
          questionId: body.questionId,
          answers: body.answers,
          ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
        });
        json(response, 202, { accepted: true });
      } catch (error) {
        if (error?.code === 'GROK_ACP_QUESTION_EXPIRED') json(response, 409, { error: error.message, code: error.code });
        else conversationFailure(response, error);
      }
      return true;
    }

    const planReviewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/plan-review$/);
    if (request.method === 'POST' && planReviewMatch) {
      const body = await readJson(request);
      if (typeof body.threadId !== 'string' || !body.threadId || body.threadId.length > 160 ||
          typeof body.reviewId !== 'string' || !body.reviewId || body.reviewId.length > 160 ||
          !['approved', 'cancelled', 'abandoned'].includes(body.outcome) ||
          (body.feedback !== undefined && (typeof body.feedback !== 'string' || body.feedback.length > 32 * 1024)) ||
          (body.outcome === 'abandoned' && body.feedback?.trim())) {
        json(response, 400, {
          error: 'threadId/reviewId, a valid outcome, and optional bounded feedback are required',
        });
        return true;
      }
      const session = await managedSession(response, planReviewMatch[1]);
      if (!session) return true;
      try {
        await registry.respondPlanReview(session, {
          threadId: body.threadId,
          reviewId: body.reviewId,
          outcome: body.outcome,
          ...(body.feedback === undefined ? {} : { feedback: body.feedback }),
        });
        json(response, 202, { accepted: true, outcome: body.outcome });
      } catch (error) {
        if (error?.code === 'GROK_ACP_PLAN_EXPIRED') json(response, 409, { error: error.message, code: error.code });
        else conversationFailure(response, error);
      }
      return true;
    }

    const permissionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/permission$/);
    if (request.method === 'POST' && permissionMatch) {
      const body = await readJson(request);
      if (typeof body.permissionId !== 'string' || !body.permissionId || body.permissionId.length > 160 ||
          typeof body.optionId !== 'string' || !body.optionId || body.optionId.length > 160) {
        json(response, 400, { error: 'permissionId and optionId must be non-empty strings' });
        return true;
      }
      const session = await managedSession(response, permissionMatch[1]);
      if (!session) return true;
      try {
        await registry.respondPermission(session, body);
        json(response, 202, { accepted: true });
      } catch (error) {
        if (error?.code === 'GROK_ACP_PERMISSION_EXPIRED') json(response, 409, { error: error.message, code: error.code });
        else conversationFailure(response, error);
      }
      return true;
    }

    const cancelMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      await readJson(request);
      const session = await managedSession(response, cancelMatch[1]);
      if (!session) return true;
      try { json(response, 202, await registry.cancel(session)); }
      catch (error) { conversationFailure(response, error); }
      return true;
    }

    const reorderMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/queue\/reorder$/);
    if (request.method === 'POST' && reorderMatch) {
      const body = await readJson(request);
      if (!Array.isArray(body.queueIds) || body.queueIds.length > 100 ||
          body.queueIds.some((id) => typeof id !== 'string' || !id || id.length > 80)) {
        json(response, 400, { error: 'queueIds must contain at most 100 queue ids' });
        return true;
      }
      const session = await managedSession(response, reorderMatch[1]);
      if (!session) return true;
      try { json(response, 202, await registry.reorderQueuedInputs(session, body.queueIds)); }
      catch (error) {
        if (error?.code === 'GROK_ACP_QUEUE_INVALID') json(response, 409, { error: error.message, code: error.code });
        else conversationFailure(response, error);
      }
      return true;
    }

    const queueMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/queue\/([^/]+)(?:\/(steer))?$/);
    if (queueMatch && (request.method === 'DELETE' || (request.method === 'POST' && queueMatch[3] === 'steer'))) {
      const queueId = decodeURIComponent(queueMatch[2]);
      if (!queueId || queueId.length > 80) {
        json(response, 400, { error: 'queue id is invalid' });
        return true;
      }
      const session = await managedSession(response, queueMatch[1]);
      if (!session) return true;
      try {
        const result = queueMatch[3] === 'steer'
          ? await registry.steerQueuedInput(session, queueId)
          : await registry.removeQueuedInput(session, queueId);
        json(response, 202, result);
      } catch (error) {
        if (['GROK_ACP_QUEUE_EXPIRED', 'GROK_ACP_SESSION_IDLE'].includes(error?.code)) {
          json(response, 409, { error: error.message, code: error.code });
        } else conversationFailure(response, error);
      }
      return true;
    }

    return false;
  };
}
