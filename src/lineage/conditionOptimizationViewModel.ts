import type { ConditionOptimizationReport, ConditionOptimizationReportItem } from './rawsqlAdapter';

export interface ConditionOptimizationViewModel {
  blocked: ConditionOptimizationReportItem[];
  changed: boolean;
  moved: ConditionOptimizationReportItem[];
  unchangedLabel: string;
  warnings: ConditionOptimizationReportItem[];
}

export function buildConditionOptimizationViewModel(report: ConditionOptimizationReport): ConditionOptimizationViewModel {
  return {
    blocked: [...report.skipped, ...report.errors].filter(hasDisplayableOptimizationItem),
    changed: report.changed,
    moved: report.applied.filter(hasDisplayableOptimizationItem),
    unchangedLabel: report.unchangedAvailable ? String(report.unchangedCount) : '-',
    warnings: report.warnings.filter(hasDisplayableOptimizationItem),
  };
}

function hasDisplayableOptimizationItem(item: ConditionOptimizationReportItem): boolean {
  return Boolean(item.displaySql || item.reason);
}
