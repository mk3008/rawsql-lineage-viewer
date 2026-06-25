import type { LineageNode } from '../domain/lineage';

export function isUnionNode(node: Pick<LineageNode, 'label' | 'type'>): boolean {
  return node.type === 'derived' && /^union(?:\s+all)?\b/i.test(node.label.trim());
}
