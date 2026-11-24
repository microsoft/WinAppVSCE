import { normalizeEnumerateResult, VisualNode, VisualTreeEnumerateResult } from './protocol';

export function findTreeNode(nodes: VisualNode[], handle: string): VisualNode | undefined {
    for (const node of nodes) {
        if (node.handle === handle) { return node; }
        const child = findTreeNode(node.children ?? [], handle);
        if (child) { return child; }
    }
    return undefined;
}

/** A subtree response must contain its requested root before it can replace it. */
export function subtreeRoot(result: VisualTreeEnumerateResult, handle: string): VisualNode {
    const node = findTreeNode(normalizeEnumerateResult(result), handle);
    if (!node) { throw new Error(`The engine did not return the requested element ${handle}.`); }
    return node;
}

export function replaceSubtree(nodes: VisualNode[], replacement: VisualNode): VisualNode[] {
    const target = findTreeNode(nodes, replacement.handle);
    if (!target) { throw new Error(`Element ${replacement.handle} is no longer in the tree.`); }
    Object.assign(target, replacement);
    // A previously picked extra root can now be reachable under an expanded
    // ancestor. Keep the canonical branch and remove the duplicate root.
    return nodes.filter(root => !nodes.some(other =>
        other !== root && findTreeNode(other.children ?? [], root.handle)));
}
