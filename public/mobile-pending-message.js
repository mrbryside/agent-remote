export function pendingMessageMatchesItem(pending, item) {
  if (!pending || item?.type !== 'message' || item.role !== 'user' ||
      pending.baselineItemIds?.includes(item.id)) return false;
  const itemText = typeof item.text === 'string' ? item.text : '';
  if (pending.text && !itemText.includes(pending.text)) return false;
  const itemAttachments = Array.isArray(item.attachments) ? item.attachments : [];
  return (pending.attachments || []).every((attachment) =>
    itemAttachments.some((candidate) => candidate.id === attachment.id || candidate.name === attachment.name) ||
    itemText.includes(attachment.name));
}
