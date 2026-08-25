function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status) {
  if (status === 'calling') return 'Calling';
  if (status === 'working' || status === 'running') return 'Running';
  if (status === 'completed') return 'Done';
  if (status === 'failed' || status === 'error') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'pending') return 'Pending';
  return 'Ready';
}

export function createMobileInteractionRenderer({
  pendingQuestions, pendingPlanReviews, onQuestionStateChange, rerender,
  getSessionName, getThreadId, respondQuestion, respondPlanReview, refresh,
}) {
  function updateQuestionState(questionId, next) {
    pendingQuestions.set(questionId, next);
    onQuestionStateChange();
  }

  function questionAnswerValues(fieldset) {
    const selected = Array.from(fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .filter((control) => control.checked)
      .map((control) => control.dataset.other === 'true'
        ? fieldset.querySelector('[data-question-custom]')?.value.trim()
        : control.value)
      .filter(Boolean);
    return selected;
  }

  function keepCustomOptionVisible(customInput) {
    const reveal = () => customInput.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    window.visualViewport?.addEventListener('resize', reveal, { once: true });
  }

  function questionNode(item, { docked = false } = {}) {
    const localState = pendingQuestions.get(item.questionId);
    const resolved = !['calling', 'pending', 'working'].includes(item.status);
    if (resolved || item.answers || item.answerSummary) pendingQuestions.delete(item.questionId);
    const pending = resolved ? undefined : localState;
    const submitting = pending?.status === 'submitting';
    const card = element('article', 'mobile-question-card');
    if (docked) card.classList.add('mobile-question-docked');
    card.dataset.questionId = item.questionId;
    card.dataset.state = submitting ? 'working' : item.status || 'pending';
    const header = element('header', 'mobile-question-header');
    const copy = element('span');
    copy.append(element('strong', '', item.title || 'Question'));
    const status = element('span', 'mobile-question-status', submitting ? 'Sending…' : statusLabel(item.status));
    status.dataset.state = submitting ? 'working' : item.status || 'pending';
    header.append(copy, status);
    card.append(header);

    if (resolved || item.answers || item.answerSummary) {
      const summary = item.answerSummary || Object.values(item.answers || {}).flat().filter(Boolean).join(' · ');
      if (summary) card.append(element('p', 'mobile-question-summary', summary));
      return card;
    }
    if (item.status === 'calling') {
      card.append(element('p', 'mobile-question-live', 'Preparing choices…'));
      return card;
    }
    if (!(item.questions || []).length) {
      card.append(element('p', 'mobile-question-live', 'Preparing choices…'));
      return card;
    }

    const questions = item.questions || [];
    const lastStep = Math.max(questions.length - 1, 0);
    const step = Math.min(Math.max(pending?.step || 0, 0), lastStep);
    card.dataset.questionStep = String(step);
    const question = questions[step];
    const form = element('form', 'mobile-question-form');
    form.append(element('p', 'mobile-question-progress', `Question ${step + 1} of ${questions.length}`));
    const live = element('p', 'mobile-question-live');
    live.setAttribute('aria-live', 'polite');
    if (pending?.status === 'failed') live.textContent = pending.error || 'Could not send your answer. Try again.';
    const fieldset = element('fieldset', 'mobile-question-fieldset');
    const legend = element('legend', '', question?.question || `Question ${step + 1}`);
    fieldset.append(legend);
    const options = element('div', 'mobile-question-options');
    const inputType = question?.multiSelect ? 'checkbox' : 'radio';
    const name = `question-${item.questionId}-${step}`;
    for (const [optionIndex, option] of (question?.options || []).entries()) {
      const label = element('label', 'mobile-question-option');
      const control = element('input');
      control.type = inputType;
      control.name = name;
      control.value = option.label || `Option ${optionIndex + 1}`;
      control.disabled = submitting;
      control.checked = Boolean(pending?.values?.[question.question]?.includes(control.value));
      const copy = element('span');
      copy.append(element('strong', '', option.label || `Option ${optionIndex + 1}`));
      if (option.description) copy.append(element('small', '', option.description));
      if (option.preview) copy.append(element('code', '', option.preview));
      label.append(control, copy);
      options.append(label);
    }
    const other = element('label', 'mobile-question-option mobile-question-other');
    const otherControl = element('input');
    otherControl.type = inputType;
    otherControl.name = name;
    otherControl.value = 'Other';
    otherControl.dataset.other = 'true';
    otherControl.disabled = submitting;
    const otherCopy = element('span');
    otherCopy.append(element('strong', '', 'Other'));
    const custom = element('input', 'mobile-question-custom');
    custom.type = 'text';
    custom.placeholder = 'Add your own answer';
    custom.setAttribute('aria-label', `Other answer for ${question?.question || `question ${step + 1}`}`);
    custom.dataset.questionCustom = 'true';
    custom.disabled = submitting;
    custom.value = pending?.customs?.[question?.question] || '';
    otherControl.checked = Boolean(custom.value);
    custom.addEventListener('focus', () => {
      otherControl.checked = true;
      updateValidity();
      keepCustomOptionVisible(custom);
    });
    otherCopy.append(custom);
    other.append(otherControl, otherCopy);
    options.append(other);
    fieldset.append(options);
    form.append(fieldset);
    const actions = element('div', 'mobile-question-actions');
    actions.dataset.firstStep = String(step === 0);
    const back = element('button', 'mobile-question-back', 'Back');
    back.type = 'button';
    back.hidden = step === 0;
    back.disabled = submitting;
    const skip = element('button', 'mobile-question-skip', 'Skip');
    skip.type = 'button';
    skip.disabled = submitting;
    const submit = element('button', 'mobile-question-submit', step < lastStep ? 'Next' : pending?.status === 'failed' ? 'Try again' : 'Continue');
    submit.type = step < lastStep ? 'button' : 'submit';
    submit.disabled = true;
    actions.append(back, skip, submit);
    form.append(live, actions);

    function updateValidity() {
      submit.disabled = submitting || questionAnswerValues(fieldset).length === 0;
    }

    function rememberSelections() {
      if (submitting) return;
      const previous = pendingQuestions.get(item.questionId);
      updateQuestionState(item.questionId, {
        status: previous?.status === 'failed' ? 'failed' : 'editing',
        step,
        values: { ...previous?.values, [question.question]: questionAnswerValues(fieldset) },
        customs: { ...previous?.customs, [question.question]: custom.value.trim() },
        ...(previous?.error ? { error: previous.error } : {}),
      });
    }

    function showStep(nextStep) {
      const previous = pendingQuestions.get(item.questionId) || {};
      const { error, ...editable } = previous;
      updateQuestionState(item.questionId, { ...editable, status: 'editing', step: nextStep });
      rerender();
    }

    async function submitQuestion(outcome) {
      if (submitting) return;
      const values = { ...pending?.values, [question.question]: questionAnswerValues(fieldset) };
      const customs = { ...pending?.customs, [question.question]: custom.value.trim() };
      const answers = Object.fromEntries(Object.entries(values).map(([question, selected]) => [question, selected.join(', ')]));
      updateQuestionState(item.questionId, { status: 'submitting', step, values, customs });
      rerender();
      try {
        await respondQuestion(getSessionName(), item.threadId || getThreadId(), item.questionId, answers, outcome);
      } catch (error) {
        updateQuestionState(item.questionId, {
          ...pendingQuestions.get(item.questionId), status: 'failed', error: error.message,
        });
        rerender();
        void refresh();
      }
    }

    form.addEventListener('input', () => { updateValidity(); rememberSelections(); });
    form.addEventListener('change', () => { updateValidity(); rememberSelections(); });
    back.addEventListener('click', () => {
      rememberSelections();
      showStep(step - 1);
    });
    if (step < lastStep) submit.addEventListener('click', () => {
      if (!submit.disabled) {
        rememberSelections();
        showStep(step + 1);
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!submit.disabled) void submitQuestion('accepted');
    });
    skip.addEventListener('click', () => void submitQuestion('skip_interview'));
    updateValidity();
    card.append(form);
    return card;
  }

  function planReviewState(item) {
    const current = pendingPlanReviews.get(item.reviewId);
    if (current?.content === item.planContent) return current;
    const next = {
      content: item.planContent, selection: undefined, comments: [],
      status: 'editing', error: '', note: '', commentDraft: '',
    };
    pendingPlanReviews.set(item.reviewId, next);
    return next;
  }

  function planLineKind(source, fenced) {
    if (/^\s*```/.test(source)) return 'fence';
    if (fenced) return 'code';
    if (/^\s*#{1,6}\s+/.test(source)) return 'heading';
    if (/^\s*(?:[-*+] |\d+[.)] )/.test(source)) return 'list';
    return source.trim() ? 'text' : 'blank';
  }

  function planFeedback(state, outcome, extra) {
    const blocks = state.comments.map((comment) => {
      const location = comment.start === comment.end
        ? `@plan.md:${comment.start}` : `@plan.md:${comment.start}-${comment.end}`;
      return `${location}\n${comment.text}`;
    });
    if (extra.trim()) blocks.push(extra.trim());
    if (!blocks.length) return '';
    const lead = outcome === 'cancelled'
      ? 'The user wants to revise the plan. The user said:'
      : 'The user approved the plan with these review comments:';
    return `${lead}\n${blocks.join('\n\n')}`;
  }

  function planReviewNode(item) {
    const local = planReviewState(item);
    const card = element('section', 'mobile-plan-review');
    card.dataset.reviewId = item.reviewId;
    card.dataset.state = local.status;
    const header = element('header', 'mobile-plan-review-header');
    const copy = element('span');
    copy.append(
      element('small', '', 'Plan review'),
      element('strong', '', 'Review plan.md'),
      element('p', '', 'Tap one line, then another to select a range and leave a comment.'),
    );
    const status = element('span', 'mobile-question-status', local.status === 'submitting' ? 'Sending…' : 'Pending');
    header.append(copy, status);

    const documentView = element('div', 'mobile-plan-document');
    documentView.setAttribute('role', 'listbox');
    documentView.setAttribute('aria-label', 'Plan lines');
    const lineButtons = [];
    let fenced = false;
    const lines = String(item.planContent || '').replace(/\r\n?/g, '\n').split('\n');
    for (const [index, source] of lines.entries()) {
      const lineNumber = index + 1;
      const kind = planLineKind(source, fenced);
      const line = element('button', 'mobile-plan-line');
      line.type = 'button';
      line.dataset.line = String(lineNumber);
      line.dataset.kind = kind;
      line.setAttribute('role', 'option');
      const displayed = kind === 'heading' ? source.replace(/^\s*#{1,6}\s+/, '') : source;
      line.append(element('span', 'mobile-plan-line-number', String(lineNumber)), element('span', 'mobile-plan-line-text', displayed || ' '));
      lineButtons.push(line);
      documentView.append(line);
      if (/^\s*```/.test(source)) fenced = !fenced;
    }

    const commentEditor = element('section', 'mobile-plan-comment-editor');
    commentEditor.hidden = !local.selection;
    const commentLabel = element('label', '', local.selection
      ? `Comment on line ${local.selection.start}${local.selection.end !== local.selection.start ? `–${local.selection.end}` : ''}`
      : 'Comment');
    const commentInput = element('textarea');
    commentInput.rows = 2;
    commentInput.placeholder = 'What should Grok change here?';
    commentInput.setAttribute('aria-label', commentLabel.textContent);
    commentInput.value = local.commentDraft;
    const commentActions = element('div', 'mobile-plan-comment-actions');
    const cancelComment = element('button', '', 'Clear selection');
    cancelComment.type = 'button';
    const saveComment = element('button', '', 'Add comment');
    saveComment.type = 'button';
    saveComment.disabled = true;
    commentActions.append(cancelComment, saveComment);
    commentEditor.append(commentLabel, commentInput, commentActions);

    const comments = element('div', 'mobile-plan-comments');
    const notes = element('textarea', 'mobile-plan-review-notes');
    notes.rows = 2;
    notes.placeholder = 'Additional feedback (optional)';
    notes.setAttribute('aria-label', 'Additional plan feedback');
    notes.value = local.note;
    const live = element('p', 'mobile-plan-review-live', local.error);
    live.setAttribute('aria-live', 'polite');
    const actions = element('div', 'mobile-plan-review-actions');
    const requestChanges = element('button', 'mobile-plan-request-changes');
    requestChanges.type = 'button';
    requestChanges.append(element('strong', '', 'Request changes'), element('small', '', 'Send comments and keep planning'));
    const approve = element('button', 'mobile-plan-approve');
    approve.type = 'button';
    approve.append(element('strong', '', 'Approve plan'), element('small', '', 'Leave Plan mode and start the work'));
    const quit = element('button', 'mobile-plan-abandon', 'Quit Plan mode');
    quit.type = 'button';
    actions.append(requestChanges, approve, quit);

    function paintSelection() {
      const selection = local.selection;
      for (const line of lineButtons) {
        const value = Number(line.dataset.line);
        const selected = Boolean(selection && value >= selection.start && value <= selection.end);
        line.setAttribute('aria-selected', String(selected));
      }
      commentEditor.hidden = !selection;
      if (selection) {
        commentLabel.textContent = `Comment on line ${selection.start}${selection.end !== selection.start ? `–${selection.end}` : ''}`;
        commentInput.setAttribute('aria-label', commentLabel.textContent);
      }
    }

    function paintComments() {
      comments.replaceChildren();
      for (const [index, comment] of local.comments.entries()) {
        const row = element('div', 'mobile-plan-comment');
        const label = comment.start === comment.end ? `Line ${comment.start}` : `Lines ${comment.start}–${comment.end}`;
        const remove = element('button', '', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          local.comments.splice(index, 1);
          paintComments();
          updateActions();
        });
        row.append(element('small', '', label), element('p', '', comment.text), remove);
        comments.append(row);
      }
      comments.hidden = local.comments.length === 0;
    }

    function updateActions() {
      const busy = local.status === 'submitting';
      requestChanges.disabled = busy || (!local.comments.length && !notes.value.trim());
      approve.disabled = busy;
      quit.disabled = busy;
      for (const line of lineButtons) line.disabled = busy;
    }

    for (const line of lineButtons) line.addEventListener('click', () => {
      const value = Number(line.dataset.line);
      if (!local.selection || local.selection.start !== local.selection.end) {
        local.selection = { start: value, end: value };
      } else if (value === local.selection.start) {
        local.selection = undefined;
      } else {
        local.selection = {
          start: Math.min(local.selection.start, value),
          end: Math.max(local.selection.start, value),
        };
      }
      commentInput.value = '';
      local.commentDraft = '';
      saveComment.disabled = true;
      paintSelection();
      if (local.selection) commentInput.focus({ preventScroll: true });
    });
    commentInput.addEventListener('input', () => {
      local.commentDraft = commentInput.value;
      saveComment.disabled = !commentInput.value.trim();
    });
    cancelComment.addEventListener('click', () => {
      local.selection = undefined;
      commentInput.value = '';
      local.commentDraft = '';
      paintSelection();
    });
    saveComment.addEventListener('click', () => {
      if (!local.selection || !commentInput.value.trim()) return;
      local.comments.push({ ...local.selection, text: commentInput.value.trim() });
      local.selection = undefined;
      commentInput.value = '';
      local.commentDraft = '';
      paintSelection();
      paintComments();
      updateActions();
    });
    notes.addEventListener('input', () => { local.note = notes.value; updateActions(); });

    async function submit(outcome) {
      if (local.status === 'submitting') return;
      const feedback = planFeedback(local, outcome, notes.value);
      if (outcome === 'cancelled' && !feedback) return;
      local.status = 'submitting';
      local.error = '';
      card.dataset.state = 'submitting';
      status.textContent = 'Sending…';
      live.textContent = '';
      updateActions();
      try {
        await respondPlanReview(getSessionName(), item.threadId || getThreadId(), item.reviewId, outcome, feedback);
      } catch (error) {
        local.status = 'failed';
        local.error = error.message || 'Could not send plan review. Try again.';
        card.dataset.state = 'failed';
        status.textContent = 'Try again';
        live.textContent = local.error;
        updateActions();
        void refresh();
      }
    }
    requestChanges.addEventListener('click', () => void submit('cancelled'));
    approve.addEventListener('click', () => void submit('approved'));
    quit.addEventListener('click', () => void submit('abandoned'));
    paintSelection();
    paintComments();
    updateActions();
    card.append(header, documentView, commentEditor, comments, notes, live, actions);
    return card;
  }

  return { planReviewNode, questionNode };
}
