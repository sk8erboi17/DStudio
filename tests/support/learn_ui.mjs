// Learn block actions appear on pointer hover or keyboard focus of their row.
// Tests reach them the way a learner does: point at the row, then click.
const actionSelector = label => `.roadmap-node-actions [aria-label=${JSON.stringify(String(label))}]`;
export const topicAction = (page, label) => page.locator(`.roadmap-topic ${actionSelector(label)}`);
const topicRow = (page, label) => page.locator('.roadmap-topic__node', { has: page.locator(actionSelector(label)) });

export async function studyTopic(page, title) {
  await topicRow(page, `Study ${title}`).hover();
  await page.getByRole('button', { name: `Study ${title}`, exact: true }).click();
}

export async function topicMenu(page, title, item) {
  await topicRow(page, `More actions: ${title}`).hover();
  await page.getByRole('button', { name: `More actions: ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
