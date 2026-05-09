import { IDeferred, defer, wrapFunction, type INode } from 'markmap-common';
import { Toolbar } from 'markmap-toolbar';
import {
  defaultOptions,
  deriveOptions,
  type IMarkmapJSONOptions,
  type Markmap,
} from 'markmap-view';

declare let mm: Markmap;

const vscode = acquireVsCodeApi();
let firstTime = true;
let root: INode | undefined;
let style: HTMLStyleElement;
let active:
  | {
      node: INode;
      el: Element;
    }
  | undefined;
const activeNodeOptions: {
  placement?: 'center' | 'visible';
} = {};
let loading: IDeferred<void> | undefined;
// Preserve fold state across data updates
const preservedFolds = new Map<string, number>();

function preserveFolds(node: INode | undefined) {
  preservedFolds.clear();
  if (!node) return;
  function dfs(n: INode) {
    if (n.payload?.fold !== undefined) {
      preservedFolds.set(n.content, n.payload.fold);
    }
    n.children?.forEach((child) => {
      if (child) dfs(child);
    });
  }
  dfs(node);
}

function restoreFolds(node: INode) {
  function dfs(n: INode) {
    const saved = preservedFolds.get(n.content);
    if (saved !== undefined) {
      n.payload.fold = saved;
    }
    n.children?.forEach((child) => {
      if (child) dfs(child);
    });
  }
  dfs(node);
}

let childCountFontSize = 10;

function setFoldAll(fold: number) {
  if (!root) return;
  root.children?.forEach((child) => {
    function dfs(n: INode) {
      n.payload = { ...n.payload, fold };
      n.children?.forEach((c) => {
        if (c) dfs(c);
      });
    }
    if (child) dfs(child);
  });
  mm.renderData();
}

const handlers = {
  async setData(data: {
    root?: INode;
    jsonOptions?: IMarkmapJSONOptions & {
      activeNode?: {
        placement?: 'center' | 'visible';
      };
    };
    childCountFontSize?: number;
  }) {
    childCountFontSize = data.childCountFontSize ?? 10;
    loading = defer();
    preserveFolds(root);
    await mm.setData((root = data.root), {
      ...defaultOptions,
      ...deriveOptions(data.jsonOptions),
    });
    restoreFolds(root);
    activeNodeOptions.placement = data.jsonOptions?.activeNode?.placement;
    if (firstTime) {
      await mm.fit();
      firstTime = false;
    }
    loading.resolve();
  },
  async setCursor(options: { line: number; autoExpand?: boolean }) {
    await loading?.promise;
    const result = root && findActiveNode(options);
    if (!result) return;
    const { node, needRerender } = result;
    if (needRerender) await mm.renderData();
    highlightNode(node);
  },
  setCSS(data: string) {
    if (!style) {
      style = document.createElement('style');
      document.head.append(style);
    }
    style.textContent = data || '';
  },
  checkTheme,
  downloadSvg(path: string) {
    const content = new XMLSerializer().serializeToString(mm.svg.node());
    vscode.postMessage({ type: 'downloadSvg', data: { content, path } });
  },
  toggleNode(recursive: boolean) {
    if (!active) return;
    mm.toggleNode(active.node, recursive);
  },
};
window.addEventListener('message', (e) => {
  const { type, data } = e.data;
  const handler = handlers[type];
  handler?.(data);
});
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement)?.closest('a');
  if (el) {
    const href = el.getAttribute('href');
    if (href.startsWith('#')) {
      const node = findHeading(href.slice(1));
      highlightNode(node);
    } else if (!href.includes('://')) {
      vscode.postMessage({
        type: 'openFile',
        data: href,
      });
    }
  }
});
vscode.postMessage({ type: 'refresh' });

const toolbar = new Toolbar();
toolbar.register({
  id: 'editAsText',
  title: 'Edit as text',
  content: createButton('Edit'),
  onClick: clickHandler('editAsText'),
});
toolbar.register({
  id: 'export',
  title: 'Export',
  content: createButton('Export'),
  onClick: clickHandler('export'),
});
toolbar.register({
  id: 'expandAll',
  title: 'Expand all',
  content: createButton('Expand'),
  onClick: () => {
    setFoldAll(0);
  },
});
toolbar.register({
  id: 'collapseAll',
  title: 'Collapse all',
  content: createButton('Collapse'),
  onClick: () => {
    setFoldAll(1);
  },
});
toolbar.setItems([
  'zoomIn',
  'zoomOut',
  'fit',
  'recurse',
  'expandAll',
  'collapseAll',
  'editAsText',
  'export',
]);

checkTheme();

setTimeout(() => {
  initialize(mm);
  toolbar.attach(mm);
  document.body.append(toolbar.el);
});

function initialize(mm: Markmap) {
  mm.renderData = wrapFunction(mm.renderData, async (fn, ...args) => {
    await fn.call(mm, ...args);
    mm.g
      .selectAll<SVGGElement, INode>(function () {
        const nodes = Array.from(this.childNodes) as Element[];
        return nodes.filter((el) => el.tagName === 'g') as SVGGElement[];
      })
      .on(
        'dblclick.focus',
        (e, d) => {
          const lines = d.payload?.lines as string | undefined;
          const line = +lines?.split(',')[0];
          if (!isNaN(line))
            vscode.postMessage({ type: 'setFocus', data: line });
        },
        true,
      );
    renderChildCounts();
  });
}

function renderChildCounts() {
  mm.g.selectAll('.markmap-childcount').remove();
  if (!childCountFontSize) return;
  mm.g
    .selectAll<SVGGElement, INode>(function () {
      const nodes = Array.from(this.childNodes) as Element[];
      return nodes.filter((el) => el.tagName === 'g') as SVGGElement[];
    })
    .each(function (d) {
      if (!d || !d.payload?.fold || !d.children?.length) return;
      const circle = this.querySelector('circle');
      if (!circle) return;
      const r = +circle.getAttribute('r') || 6;
      const ns = 'http://www.w3.org/2000/svg';
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('class', 'markmap-childcount');
      text.setAttribute('x', String(r));
      text.setAttribute('y', String(r / 2 + 1));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('fill', 'currentColor');
      text.setAttribute('opacity', '0.4');
      text.setAttribute('font-size', String(childCountFontSize));
      text.textContent = String(d.children.length);
      this.appendChild(text);
    });
}

function checkTheme() {
  // https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content
  const isDark = ['vscode-dark', 'vscode-high-contrast'].some((cls) =>
    document.body.classList.contains(cls),
  );
  document.documentElement.classList[isDark ? 'add' : 'remove']('markmap-dark');
}

function createButton(text: string) {
  const el = document.createElement('div');
  el.className = 'btn-text';
  el.textContent = text;
  return el;
}

function clickHandler(type: string) {
  return () => {
    vscode.postMessage({ type });
  };
}

function findHeading(id: string) {
  function dfs(node: INode) {
    if (!/^h\d$/.test(node.payload.tag as string)) return false;
    const normalizedId = node.content.trim().replace(/\W/g, '-').toLowerCase();
    if (normalizedId === id) {
      target = node;
      return true;
    }
    return node.children?.some(dfs);
  }
  let target: INode | undefined;
  dfs(root);
  return target;
}

function findActiveNode({
  line,
  autoExpand = true,
}: {
  line: number;
  autoExpand?: boolean;
}) {
  function dfs(node: INode, ancestors: INode[] = []) {
    const [start, end] =
      (node.payload?.lines as string)?.split(',').map((s) => +s) || [];
    if (start >= 0 && start <= line && line < end) {
      best = node;
      bestAncestors = ancestors;
    }
    ancestors = [...ancestors, node];
    node.children?.forEach((child) => {
      dfs(child, ancestors);
    });
  }
  let best: INode | undefined;
  let bestAncestors: INode[] = [];
  dfs(root);
  let needRerender = false;
  if (autoExpand) {
    bestAncestors.forEach((node) => {
      if (node.payload?.fold) {
        node.payload.fold = 0;
        needRerender = true;
      }
    });
  }
  return best && { node: best, needRerender };
}

async function highlightNode(node?: INode) {
  await mm.setHighlight(node);
  if (!node) return;
  await mm[
    activeNodeOptions.placement === 'center' ? 'centerNode' : 'ensureVisible'
  ](node, {
    bottom: 80,
  });
}
