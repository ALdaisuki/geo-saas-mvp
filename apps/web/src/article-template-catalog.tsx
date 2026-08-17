import { Check, CheckCircle2, FileText, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import {
  ARTICLE_TEMPLATE_CATEGORIES,
  ARTICLE_TEMPLATE_LIBRARY_NAME,
  DEFAULT_ARTICLE_TEMPLATE_ID,
  type ArticleTemplate,
  type ArticleTemplateCategory,
} from "@geo/contracts";
import { editorialProfileLabel } from "./operation-labels.js";

import "./operations-console-tools.css";

export interface ArticleTemplateCatalogProps {
  readonly templates: readonly ArticleTemplate[];
  readonly catalogVersion: string;
  readonly selectedTemplateId?: string;
  readonly onSelect?: (template: ArticleTemplate) => void;
  readonly actionLabel?: string;
}

export function ArticleTemplateCatalog({
  templates,
  catalogVersion,
  selectedTemplateId,
  onSelect,
  actionLabel = "使用此模板",
}: ArticleTemplateCatalogProps) {
  const [category, setCategory] = useState<"all" | ArticleTemplateCategory>("all");
  const [query, setQuery] = useState("");
  const [localSelection, setLocalSelection] = useState(
    selectedTemplateId ?? DEFAULT_ARTICLE_TEMPLATE_ID,
  );
  const activeId = selectedTemplateId ?? localSelection;
  const visibleTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return templates.filter((template) => {
      if (category !== "all" && template.category !== category) return false;
      if (normalizedQuery.length === 0) return true;
      return [
        template.name,
        template.scenario,
        template.travelExample,
        template.benefit,
        ...template.geoMechanisms,
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery);
    });
  }, [category, query, templates]);
  const activeTemplate = templates.find((template) => template.id === activeId);
  const selected =
    (activeTemplate !== undefined && visibleTemplates.includes(activeTemplate)
      ? activeTemplate
      : visibleTemplates[0]) ?? templates[0];

  function select(template: ArticleTemplate) {
    setLocalSelection(template.id);
    onSelect?.(template);
  }

  if (selected === undefined) return null;

  return (
    <section
      className="article-template-catalog ops-console-tool ops-template-catalog"
      aria-label={ARTICLE_TEMPLATE_LIBRARY_NAME}
      data-catalog-version={catalogVersion}
    >
      <div className="template-catalog-toolbar">
        <div className="template-catalog-title">
          <span>{ARTICLE_TEMPLATE_LIBRARY_NAME}</span>
          <strong>{templates.length} 套旅行社内容结构</strong>
          <small title={catalogVersion}>版本 {catalogVersion}</small>
        </div>
        <div className="template-search" role="search">
          <Search aria-hidden="true" size={15} />
          <input
            type="search"
            aria-label="搜索文章模板"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索场景、出行对象或写作角度"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="清空模板搜索"
              title="清空搜索"
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="template-categories" aria-label="模板分类">
        {ARTICLE_TEMPLATE_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={category === item.id ? "active" : ""}
            aria-pressed={category === item.id}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="template-catalog-layout">
        <div className="template-directory-pane">
          <header className="template-directory-heading">
            <strong>旅行社模板目录</strong>
            <span>{visibleTemplates.length} 项</span>
          </header>
          <div className="template-list" role="listbox" aria-label="文章模板">
            {visibleTemplates.length === 0 ? (
              <div className="template-empty" role="status">
                <Search aria-hidden="true" size={20} />
                <strong>没有匹配的模板</strong>
                <span>调整关键词或模板分类</span>
              </div>
            ) : (
              visibleTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  role="option"
                  aria-selected={template.id === selected.id}
                  className={template.id === selected.id ? "selected" : ""}
                  onClick={() => select(template)}
                >
                  <span className="template-list-icon" aria-hidden="true">
                    <FileText size={15} />
                  </span>
                  <span className="template-list-copy">
                    <span className="template-list-title">
                      <strong>{template.name}</strong>
                      <em>{editorialProfileLabel(template.editorialProfile)}</em>
                    </span>
                    <small>{template.benefit}</small>
                  </span>
                  {template.id === selected.id ? <Check aria-hidden="true" size={15} /> : null}
                </button>
              ))
            )}
          </div>
        </div>
        {visibleTemplates.length === 0 ? (
          <div className="template-detail-empty" role="status">
            <FileText aria-hidden="true" size={24} />
            <strong>当前筛选没有可预览模板</strong>
          </div>
        ) : (
          <article className="template-detail" aria-live="polite">
            <header>
              <div>
                <span className="template-profile-label">
                  {editorialProfileLabel(selected.editorialProfile)}
                </span>
                <h3>{selected.name}</h3>
                <p>{selected.scenario}</p>
              </div>
              <button
                className="button-primary"
                type="button"
                title={actionLabel}
                onClick={() => select(selected)}
              >
                {selected.id === activeId ? (
                  <CheckCircle2 aria-hidden="true" size={16} />
                ) : (
                  <Sparkles aria-hidden="true" size={16} />
                )}
                {actionLabel}
              </button>
            </header>
            <div className="template-benefit">
              <Sparkles aria-hidden="true" size={17} />
              <div>
                <span>客户收益</span>
                <strong>{selected.benefit}</strong>
              </div>
            </div>
            <div className="template-detail-grid">
              <section>
                <h4>GEO 机制</h4>
                <div className="template-signal-list">
                  {selected.geoMechanisms.map((mechanism) => (
                    <span key={mechanism}>{mechanism}</span>
                  ))}
                </div>
              </section>
              <section>
                <h4>旅行社写作示例</h4>
                <p>{selected.travelExample}</p>
              </section>
              <section>
                <h4>文章结构</h4>
                <ol>
                  {selected.outline.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </section>
              <section>
                <h4>发布前证据</h4>
                <ul>
                  {selected.evidenceRequirements.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            </div>
            <footer>
              <ShieldCheck aria-hidden="true" size={17} />
              <div>
                <span>风险边界</span>
                <p>{selected.riskBoundaries.join("；")}</p>
              </div>
            </footer>
          </article>
        )}
      </div>
    </section>
  );
}
