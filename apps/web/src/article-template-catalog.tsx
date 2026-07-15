import { Check, CheckCircle2, FileText, Search, ShieldCheck, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import {
  ARTICLE_TEMPLATE_CATEGORIES,
  ARTICLE_TEMPLATES,
  DEFAULT_ARTICLE_TEMPLATE_ID,
  type ArticleTemplate,
  type ArticleTemplateCategory,
} from "./article-templates.js";

export interface ArticleTemplateCatalogProps {
  readonly selectedTemplateId?: string;
  readonly onSelect?: (template: ArticleTemplate) => void;
  readonly actionLabel?: string;
}

export function ArticleTemplateCatalog({
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
    return ARTICLE_TEMPLATES.filter((template) => {
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
  }, [category, query]);
  const activeTemplate = ARTICLE_TEMPLATES.find((template) => template.id === activeId);
  const selected =
    (activeTemplate !== undefined && visibleTemplates.includes(activeTemplate)
      ? activeTemplate
      : visibleTemplates[0]) ?? ARTICLE_TEMPLATES[0];

  function select(template: ArticleTemplate) {
    setLocalSelection(template.id);
    onSelect?.(template);
  }

  if (selected === undefined) return null;

  return (
    <section className="article-template-catalog" aria-label="GEO 文章模板库">
      <div className="template-catalog-toolbar">
        <div>
          <span>GEO 文章模板</span>
          <strong>{ARTICLE_TEMPLATES.length} 套可审计结构</strong>
        </div>
        <label className="template-search">
          <Search size={15} />
          <span className="sr-only">搜索文章模板</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索场景、收益或机制"
          />
        </label>
      </div>
      <div className="template-categories" aria-label="模板分类">
        {ARTICLE_TEMPLATE_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={category === item.id ? "active" : ""}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="template-catalog-layout">
        <div className="template-list" role="listbox" aria-label="文章模板">
          {visibleTemplates.length === 0 ? (
            <div className="template-empty">没有匹配的模板</div>
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
                <FileText size={16} />
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.benefit}</small>
                </span>
                {template.id === selected.id ? <Check size={15} /> : null}
              </button>
            ))
          )}
        </div>
        <article className="template-detail" aria-live="polite">
          <header>
            <div>
              <span>{selected.editorialProfile.replaceAll("_", " ")}</span>
              <h3>{selected.name}</h3>
              <p>{selected.scenario}</p>
            </div>
            <button className="button-primary" type="button" onClick={() => select(selected)}>
              {selected.id === activeId ? <CheckCircle2 size={16} /> : <Sparkles size={16} />}
              {actionLabel}
            </button>
          </header>
          <div className="template-benefit">
            <Sparkles size={17} />
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
              <h4>旅行行业示例</h4>
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
            <ShieldCheck size={17} />
            <div>
              <span>风险边界</span>
              <p>{selected.riskBoundaries.join("；")}</p>
            </div>
          </footer>
        </article>
      </div>
    </section>
  );
}
