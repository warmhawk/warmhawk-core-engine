import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  name: string;
  onError?: string;
  parameters: { options?: { reset?: unknown }; jsonBody?: string };
}
interface Workflow {
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const workflow: Workflow = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../n8n/workflows/reply-poll.json'), 'utf8'),
);
const node = (name: string) => workflow.nodes.find((n) => n.name === name)!;
const targets = (name: string, output: number) =>
  (workflow.connections[name]?.main[output] ?? []).map((c) => c.node);

// n8n stops a run when a branch emits no items, and a Split In Batches loop keeps its state between
// mailboxes unless it's reset. Either one ends the round after the first mailbox, so the mailboxes
// after it are never searched and their replies never reach the Replies tab.
describe('reply-poll workflow', () => {
  it('moves on to the next mailbox when one has no pending leads', () => {
    expect(targets('Get Pending Replies For Mailbox', 0)).toEqual(['IF Has Pending Leads']);
    expect(targets('IF Has Pending Leads', 0)).toEqual(['Split Out Pending Leads']);
    expect(targets('IF Has Pending Leads', 1)).toEqual(['Loop Mailboxes']);
  });

  it('starts the lead loop afresh for each mailbox', () => {
    expect(node('Loop Pending Leads').parameters.options?.reset).toBe(
      "={{ $prevNode.name === 'Attach Mailbox Id' }}",
    );
    expect(targets('Attach Mailbox Id', 0)).toEqual(['Loop Pending Leads']);
  });

  it("keeps polling when one mailbox's IMAP or one reply fails", () => {
    expect(node('Get Pending Replies For Mailbox').onError).toBe('continueRegularOutput');
    expect(node('Search IMAP').onError).toBe('continueRegularOutput');
    expect(node('Classify Reply').onError).toBe('continueRegularOutput');
    for (const name of ['Fetch Reply Body', 'Create Reply Record']) {
      expect(node(name).onError).toBe('continueErrorOutput');
      expect(targets(name, 1)).toEqual(['Loop Pending Leads']);
    }
  });

  it('passes a delivery-failure report on, so it is stored as a bounce', () => {
    expect(node('Create Reply Record').parameters.jsonBody).toContain(
      '"bounce": $json.bounce ?? null',
    );
  });

  it('wires every connection to a real node', () => {
    const names = new Set(workflow.nodes.map((n) => n.name));
    for (const [from, { main }] of Object.entries(workflow.connections)) {
      expect(names.has(from)).toBe(true);
      for (const c of main.flat()) expect(names.has(c.node)).toBe(true);
    }
  });
});
