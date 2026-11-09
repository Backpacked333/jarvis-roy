import { AssistantCoordinator } from "./assistant/coordinator.ts";
import type { AssistantOperation } from "./assistant/coordinator.ts";
import type { AssistantPresentation, ReviewableAction } from "./assistant/contracts.ts";
import { BridgeError } from "./errors.ts";
import type { HarnessRuntime } from "./harness-runtime.ts";
import type { JarvisService } from "./service.ts";

/** A captured card stays in its original project even after manual navigation. */
export function assertPresentationProject(coordinator: AssistantCoordinator, presentation: AssistantPresentation, projectId: string): void {
  const turn = coordinator.state().turns.find(turn => turn.id === presentation.turnId);
  const focus = presentation.capturedFocus;
  const originProject = focus.kind === "room" ? focus.roomId : focus.kind === "conversation"
    ? focus.roomId ?? focus.conversationId : turn?.conversationId;
  if (!originProject || originProject !== projectId) throw new BridgeError("This visual reference belongs to another project. Return to its original workspace.", 403);
}

/** The coordinator delegates every effect to existing task/harness authorities. */
export async function createAssistantRuntime(dataDirectory: string, service: JarvisService, harness: HarnessRuntime) {
  let coordinator: AssistantCoordinator;
  const dispatchTurn = async (input: AssistantOperation) => {
    const focus = input.capturedFocus;
    let conversationId = focus.kind === "conversation" ? focus.conversationId : undefined;
    if (focus.kind === "room") {
      if (!(await harness.harness.state()).rooms.some(room => room.id === focus.roomId)) throw new BridgeError("Room not found.", 404);
      conversationId = coordinator.state().turns.slice().reverse().find(turn => turn.sessionId === input.sessionId &&
        turn.intent !== "side_question" && turn.capturedFocus.kind === "room" && turn.capturedFocus.roomId === focus.roomId && turn.conversationId)?.conversationId ?? undefined;
    }
    if (input.intent === "side_question" || !conversationId) {
      conversationId = (await service.createConversation(input.intent === "side_question" ? "Side conversation" : "Assistant conversation")).id;
    }
    const projectId = focus.kind === "room" ? focus.roomId : focus.kind === "conversation" ? focus.roomId ?? focus.conversationId : conversationId;
    let message = input.intent === "redirect_work"
      ? `Propose a revised plan for this request. Do not modify or execute an existing accepted plan without a new review.\n\n${input.text}`
      : input.text;
    if (input.capturedPresentation) {
      assertPresentationProject(coordinator, input.capturedPresentation, projectId);
      // Do not resend cached private passages. The tool reads the frozen object
      // through current project/grant checks immediately before disclosure.
      message += `\n\nCaptured visual reference: ${JSON.stringify({ id: input.capturedPresentation.id,
        revision: input.capturedPresentation.revision, kind: input.capturedPresentation.content.kind })}. Call assistant_context to inspect this exact object under its current source grants.`;
    }
    const task = await service.createTask(message, conversationId, projectId);
    if (focus.kind === "none") {
      const session = coordinator.state().sessions.find(item => item.id === input.sessionId)!;
      await coordinator.updateFocus(session.id, { expectedRevision: session.revision,
        focus: { kind: "conversation", conversationId, roomId: null } });
    }
    return { taskId: task.id, conversationId };
  };
  const stopWork = async ({ capturedFocus: focus }: AssistantOperation) => {
    if (focus.kind === "none") throw new BridgeError("Choose the task or room to cancel.", 409);
    if (focus.kind === "conversation") {
      const tasks = service.taskSnapshot().filter(task => task.conversationId === focus.conversationId &&
        ["starting", "running", "waiting", "interrupted"].includes(task.status));
      const results = await Promise.all(tasks.map(task => service.cancel(task.id)));
      if (results.some(task => !["cancelled", "completed", "failed"].includes(task.status))) throw new BridgeError("Cancellation is unconfirmed.", 503);
    } else {
      const outcomes = await Promise.allSettled([service.cancelProjectWork(focus.roomId), (async () => {
        const state = await harness.harness.state();
        for (const run of state.runs.filter(run => run.roomId === focus.roomId && run.status !== "completed" && !(run.status === "cancelled" && run.cancelConfirmed))) {
          await harness.harness.cancelRun(focus.roomId, run.id, { expectedRevision: run.revision });
        }
        for (const job of state.authorings.filter(job => job.roomId === focus.roomId && ["authoring", "waiting_question"].includes(job.status))) {
          await harness.harness.cancelAuthoring(focus.roomId, job.id, { expectedRevision: job.revision });
        }
        const after = await harness.harness.state();
        if (!after.ready || after.runs.some(run => run.roomId === focus.roomId && run.status !== "completed" && !(run.status === "cancelled" && run.cancelConfirmed)) ||
            after.authorings.some(job => job.roomId === focus.roomId && ["authoring", "waiting_question"].includes(job.status))) {
          throw new BridgeError("Room worker cancellation remains unconfirmed.", 503);
        }
      })()]);
      if (outcomes.some(result => result.status === "rejected")) {
        throw new BridgeError("Room cancellation remains unconfirmed.", 503);
      }
    }
  };
  coordinator = await AssistantCoordinator.open({ dataDirectory, adapters: {
    dispatchTurn, stopWork,
    async readAction(ref) {
      if (["accept_plan", "start_plan"].includes(ref.optionId)) {
        const state = await harness.harness.state();
        const plan = state.plans.find(plan => plan.roomId === ref.taskId && plan.id === ref.interactionId && plan.revision === ref.revision);
        if (!plan || (ref.optionId === "accept_plan" ? plan.status !== "draft" : plan.status !== "accepted" || !plan.digest)) return null;
        const room = state.rooms.find(room => room.id === plan.roomId);
        if (!room || room.policy.revision !== plan.policyRevision) return null;
        const toolName = ref.optionId === "accept_plan" ? "accept_room_plan" : "start_room_run";
        const exactArguments = JSON.stringify({ roomId: room.id, planId: plan.id, expectedPlanRevision: plan.revision,
          planDigest: plan.digest, policyRevision: room.policy.revision, goal: plan.goal, nodes: plan.nodes,
          budget: room.policy.runBudget, requestId: `voice-${plan.id}-${plan.revision}` });
        return { ...ref, scope: "room", toolName, exactArguments, reviewText: `Tool: ${toolName}\nExact arguments (JSON): ${exactArguments}`, voiceAllowed: true };
      }
      const task = service.taskSnapshot().find(task => task.id === ref.taskId && task.status === "waiting");
      const card = task?.approvals.find(card => card.id === ref.interactionId && card.revision === ref.revision && card.reviewable === true);
      if (!card || ref.optionId !== "approve" || !card.options.some(option => option.id === ref.optionId) ||
          card.expiresAt && Date.parse(card.expiresAt) <= Date.now()) return null;
      const marker = "Exact arguments (JSON): ", index = card.detail.lastIndexOf(marker);
      if (index < 0) return null;
      const exactArguments = card.detail.slice(index + marker.length);
      try { JSON.parse(exactArguments); } catch { return null; }
      const toolName = /^Tool: ([^\n]+)/.exec(card.detail)?.[1] ?? card.title;
      return { ...ref, toolName, exactArguments, reviewText: card.detail, voiceAllowed: true } satisfies ReviewableAction;
    },
    async executeAction(action) {
      if (action.scope === "room") {
        const input = JSON.parse(action.exactArguments);
        if (action.optionId === "accept_plan") await harness.harness.acceptPlan(input.roomId, input.planId, { expectedRevision: input.expectedPlanRevision });
        else if (action.optionId === "start_plan") await harness.harness.startRun(input.roomId, { requestId: input.requestId,
          planId: input.planId, expectedPlanRevision: input.expectedPlanRevision, planDigest: input.planDigest });
        else throw new BridgeError("Unsupported plan action.", 400);
      } else await service.respond(action.taskId, action.interactionId, action.optionId, action.revision);
    },
  } });
  const unsubscribe = service.subscribeTasks(tasks => {
    if (coordinator.enabled) for (const task of tasks) void coordinator.updateTask(task).catch(() => {});
  });
  return { coordinator, async close() { unsubscribe(); await coordinator.close(); } };
}
