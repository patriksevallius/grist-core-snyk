import {allCommands} from 'app/client/components/commands';
import {GristDoc} from 'app/client/components/GristDoc';
import * as kf from 'app/client/lib/koForm';
import {makeT} from 'app/client/lib/localization';
import {ColumnToMapImpl} from 'app/client/models/ColumnToMap';
import {ColumnRec, ViewSectionRec} from 'app/client/models/DocModel';
import {reportError} from 'app/client/models/errors';
import {cssHelp, cssLabel, cssRow, cssSeparator} from 'app/client/ui/RightPanelStyles';
import {cssDragRow, cssFieldEntry, cssFieldLabel} from 'app/client/ui/VisibleFieldsConfig';
import {basicButton, primaryButton, textButton} from 'app/client/ui2018/buttons';
import {theme, vars} from 'app/client/ui2018/cssVars';
import {cssDragger} from 'app/client/ui2018/draggableList';
import {textInput} from 'app/client/ui2018/editableLabel';
import {IconName} from 'app/client/ui2018/IconList';
import {icon} from 'app/client/ui2018/icons';
import {cssLink} from 'app/client/ui2018/links';
import {IOptionFull, menu, menuItem, menuText, select} from 'app/client/ui2018/menus';
import {AccessLevel, ICustomWidget, isSatisfied} from 'app/common/CustomWidget';
import {GristLoadConfig} from 'app/common/gristUrls';
import {unwrap} from 'app/common/gutil';
import {
  bundleChanges,
  Computed,
  Disposable,
  dom,
  fromKo,
  makeTestId,
  MultiHolder,
  Observable,
  styled,
  UseCBOwner
} from 'grainjs';

const t = makeT('CustomSectionConfig');

// Custom URL widget id - used as mock id for selectbox.
const CUSTOM_ID = 'custom';
const testId = makeTestId('test-config-widget-');

/**
 * Custom Widget section.
 * Allows to select custom widget from the list of available widgets
 * (taken from /widgets endpoint), or enter a Custom URL.
 * When Custom Widget has a desired access level (in accessLevel field),
 * will prompt user to approve it. "None" access level is auto approved,
 * so prompt won't be shown.
 *
 * When gristConfig.enableWidgetRepository is set to false, it will only
 * allow to specify the custom URL.
 */

class ColumnPicker extends Disposable {
  constructor(
    private _value: Observable<number|number[]|null>,
    private _column: ColumnToMapImpl,
    private _section: ViewSectionRec){
    super();
  }
  public buildDom() {
    // Rewrite value to ignore old configuration when allowMultiple is switched.
    const properValue = Computed.create(this, use => {
      const value = use(this._value);
      return Array.isArray(value) ? null : value;
    });
    properValue.onWrite(value => this._value.set(value));
    const options = Computed.create(this, use => {
      return use(this._section.columns)
        .filter(col => this._column.canByMapped(use(col.pureType)))
        .map((col) => ({value: col.getRowId(), label: use(col.label), icon: 'FieldColumn' as IconName}));
    });
    return [
      cssLabel(
        this._column.title,
        this._column.optional ? cssSubLabel(t(" (optional)")) : null,
        testId('label-for-' + this._column.name),
      ),
      this._column.description ? cssHelp(
        this._column.description,
        testId('help-for-' + this._column.name),
      ) : null,
      cssRow(
        select(
          properValue,
          options,
          {
            defaultLabel: this._column.typeDesc != "any"
              ? t("Pick a {{columnType}} column", {"columnType": this._column.typeDesc})
              : t("Pick a column")
          }
        ),
        testId('mapping-for-' + this._column.name),
      ),
    ];
  }
}

class ColumnListPicker extends Disposable {
  constructor(
    private _value: Observable<number|number[]|null>,
    private _column: ColumnToMapImpl,
    private _section: ViewSectionRec) {
    super();
  }
  public buildDom() {
    return dom.domComputed((use) => {
      return [
        cssLabel(this._column.title,
          cssLabel.cls("-required", !this._column.optional),
          testId('label-for-' + this._column.name),
        ),
        this._buildDraggableList(use),
        this._buildAddColumn()
      ];
    });
  }
  private _buildAddColumn() {
    return [
      cssRow(
        cssAddMapping(
          cssAddIcon('Plus'), t("Add") + ' ' + this._column.title,
          menu(() => {
            const otherColumns = this._getNotMappedColumns();
            const typedColumns = otherColumns.filter(this._typeFilter());
            const wrongTypeCount = otherColumns.length - typedColumns.length;
            return [
              ...typedColumns
              .map((col) => menuItem(
                () => this._addColumn(col),
                col.label.peek(),
              )),
              wrongTypeCount > 0 ? menuText(
                t("{{wrongTypeCount}} non-{{columnType}} columns are not shown", {
                  wrongTypeCount,
                  columnType: this._column.type.toLowerCase(),
                  count: wrongTypeCount
                }),
                testId('map-message-' + this._column.name)
              ) : null
            ];
          }),
          testId('add-column-for-' + this._column.name),
        )
      ),
    ];
  }

  // Helper method for filtering columns that can be picked by the widget.
  private _typeFilter = (use = unwrap) => (col: ColumnRec) => this._column.canByMapped(use(col.pureType));

  private _buildDraggableList(use: UseCBOwner) {
    return dom.update(kf.draggableList(
      this._readItems(use),
      this._renderItem.bind(this, use),
      {
        itemClass: cssDragRow.className,
        reorder: this._reorder.bind(this),
        receive: this._addColumn.bind(this),
        drag_indicator: cssDragger,
      }
    ), testId('map-list-for-' + this._column.name));
  }
  private _getNotMappedColumns(): ColumnRec[] {
    // Get all columns.
    const all = this._section.columns.peek();
    const mapped = this._list();
    return all.filter(col => !mapped.includes(col.id.peek()));
  }
  private _readItems(use: UseCBOwner): ColumnRec[] {
    let selectedRefs = (use(this._value) || []) as number[];
    // Ignore if configuration was changed from what it was saved.
    if (!Array.isArray(selectedRefs)) {
      selectedRefs = [];
    }
    // Filter columns by type - when column type has changed since mapping.
    const columns = use(this._section.columns).filter(this._typeFilter(use));
    const columnMap = new Map(columns.map(c => [c.id.peek(), c]));
    // Remove any columns that are no longer there.
    return selectedRefs.map(s => columnMap.get(s)!).filter(c => Boolean(c));
  }
  private _renderItem(use: UseCBOwner, field: ColumnRec): any {
    return cssFieldEntry(
      cssFieldLabel(
        dom.text(field.label),
        testId('ref-select-label'),
      ),
      cssRemoveIcon(
        'Remove',
        dom.on('click', () => this._remove(field)),
        testId('ref-select-remove'),
      ),
    );
  }

  // Helper method that for accessing mapped columns. Can be used to set and retrieve the value.
  private _list(value: number[]): void
  private _list(): number[]
  private _list(value?: number[]) {
    if (value) {
      this._value.set(value);
    } else {
      let current = (this._value.get() || []) as number[];
      // Ignore if the saved value is not a number.
      if (!Array.isArray(current)) {
        current = [];
      }
      return current;
    }
  }

  private _reorder(column: ColumnRec, nextColumn: ColumnRec|null): any {
    const id = column.id.peek();
    const nextId = nextColumn?.id.peek();
    const currentList = this._list();
    const indexOfId = currentList.indexOf(id);
    // Remove element from the list.
    currentList.splice(indexOfId, 1);
    const indexOfNext = nextId ? currentList.indexOf(nextId) : currentList.length;
    // Insert before next element or at the end.
    currentList.splice(indexOfNext, 0, id);
    this._list(currentList);
  }
  private _remove(column: ColumnRec): any {
    const current = this._list();
    this._value.set(current.filter(c => c != column.id.peek()));
  }
  private _addColumn(col: ColumnRec): any {
    const current = this._list();
    current.push(col.id.peek());
    this._value.set(current);
  }
}

class CustomSectionConfigurationConfig extends Disposable{
  // Does widget has custom configuration.
  private readonly _hasConfiguration: Computed<boolean>;
  constructor(private _section: ViewSectionRec, private _gristDoc: GristDoc) {
    super();
    this._hasConfiguration = Computed.create(this, use => use(_section.hasCustomOptions));
  }
  public buildDom() {
    // Show prompt, when desired access level is different from actual one.
    return dom(
      'div',
      dom.maybe(this._hasConfiguration, () =>
        cssSection(
          textButton(
            t("Open configuration"),
            dom.on('click', () => this._openConfiguration()),
            testId('open-configuration')
          )
        )
      ),
      dom.maybeOwned(use => use(this._section.columnsToMap), (owner, columns) => {
        const createObs = (column: ColumnToMapImpl) => {
          const obs = Computed.create(owner, use => {
            const savedDefinition = use(this._section.customDef.columnsMapping) || {};
            return savedDefinition[column.name];
          });
          obs.onWrite(async (value) => {
            const savedDefinition = this._section.customDef.columnsMapping.peek() || {};
            savedDefinition[column.name] = value;
            await this._section.customDef.columnsMapping.setAndSave(savedDefinition);
          });
          return obs;
        };
        // Create observables for all columns to pick.
        const mappings = columns.map(c => new ColumnToMapImpl(c)).map((column) => ({
          value: createObs(column),
          column
        }));
        return dom('div',
          this._attachColumnMappingTip(this._section.customDef.url()),
          ...mappings.map(m => m.column.allowMultiple
            ? dom.create(ColumnListPicker, m.value, m.column, this._section)
            : dom.create(ColumnPicker, m.value, m.column, this._section)),
        );
      })
    );
  }
  private _openConfiguration(): void {
    allCommands.openWidgetConfiguration.run();
  }

  private _attachColumnMappingTip(widgetUrl: string | null) {
    switch (widgetUrl) {
      // TODO: come up with a way to attach tips without hardcoding widget URLs.
      case 'https://gristlabs.github.io/grist-widget/calendar/index.html': {
        return this._gristDoc.behavioralPromptsManager.attachTip('calendarConfig', {
          popupOptions: {placement: 'left-start'},
        });
      }
      default: {
        return null;
      }
    }
  }
}

export class CustomSectionConfig extends Disposable {

  protected _customSectionConfigurationConfig: CustomSectionConfigurationConfig;
  // Holds all available widget definitions.
  private _widgets: Observable<ICustomWidget[]>;
  // Holds selected option (either custom string or a widgetId).
  private readonly _selectedId: Computed<string | null>;
  // Holds custom widget URL.
  private readonly _url: Computed<string>;
  // Enable or disable widget repository.
  private readonly _canSelect: boolean = true;
  // When widget is changed, it sets its desired access level. We will prompt
  // user to approve or reject it.
  private readonly _desiredAccess: Observable<AccessLevel|null>;
  // Current access level (stored inside a section).
  private readonly _currentAccess: Computed<AccessLevel>;




  constructor(protected _section: ViewSectionRec, private _gristDoc: GristDoc) {
    super();
    this._customSectionConfigurationConfig = new CustomSectionConfigurationConfig(_section, _gristDoc);

    // Test if we can offer widget list.
    const gristConfig: GristLoadConfig = (window as any).gristConfig || {};
    this._canSelect = gristConfig.enableWidgetRepository ?? true;

    // Array of available widgets - will be updated asynchronously.
    this._widgets = Observable.create(this, []);
    this._getWidgets().catch(reportError);
    // Request for rest of the widgets.

    // Selected value from the dropdown (contains widgetId or "custom" string for Custom URL)
    this._selectedId = Computed.create(this, use => {
      if (use(_section.customDef.widgetDef)) {
        return _section.customDef.widgetDef.peek()!.widgetId;
      }
      return CUSTOM_ID;
    });
    this._selectedId.onWrite(async value => {
      if (value === CUSTOM_ID) {
        // Select Custom URL
        bundleChanges(() => {
          // Reset whether widget should render after `grist.ready()`.
          _section.customDef.renderAfterReady(false);
          // Clear url.
          _section.customDef.url(null);
          // Clear widget definition.
          _section.customDef.widgetDef(null);
          // Reset access level to none.
          _section.customDef.access(AccessLevel.none);
          // Clear all saved options.
          _section.customDef.widgetOptions(null);
          // Reset custom configuration flag.
          _section.hasCustomOptions(false);
          // Clear column mappings.
          _section.customDef.columnsMapping(null);
          _section.columnsToMap(null);
          this._desiredAccess.set(AccessLevel.none);
        });
        await _section.saveCustomDef();
      } else {
        // Select Widget
        const selectedWidget = this._widgets.get().find(w => w.widgetId === value);
        if (!selectedWidget) {
          // should not happen
          throw new Error('Error accessing widget from the list');
        }
        // If user selected the same one, do nothing.
        if (_section.customDef.widgetDef.peek()?.widgetId === value) {
          return;
        }
        bundleChanges(() => {
          // Reset whether widget should render after `grist.ready()`.
          _section.customDef.renderAfterReady(false);
          // Clear access level
          _section.customDef.access(AccessLevel.none);
          // When widget wants some access, set desired access level.
          this._desiredAccess.set(selectedWidget.accessLevel || AccessLevel.none);
          // Update widget definition.
          _section.customDef.widgetDef(selectedWidget);
          // Update widget URL.
          _section.customDef.url(selectedWidget.url);
          // Clear options.
          _section.customDef.widgetOptions(null);
          // Clear has custom configuration.
          _section.hasCustomOptions(false);
          // Clear column mappings.
          _section.customDef.columnsMapping(null);
          _section.columnsToMap(null);
        });
        await _section.saveCustomDef();
      }
    });

    // Url for the widget, taken either from widget definition, or provided by hand for Custom URL.
    // For custom widget, we will store url also in section definition.
    this._url = Computed.create(this, use => use(_section.customDef.url) || '');
    this._url.onWrite(async newUrl => {
      bundleChanges(() => {
        _section.customDef.renderAfterReady(false);
        _section.customDef.url(newUrl);
      });
      await _section.saveCustomDef();
    });

    // Compute current access level.
    this._currentAccess = Computed.create(
      this,
      use => (use(_section.customDef.access) as AccessLevel) || AccessLevel.none
    );
    this._currentAccess.onWrite(async newAccess => {
      await _section.customDef.access.setAndSave(newAccess);
    });
    // From the start desired access level is the same as current one.
    this._desiredAccess = fromKo(_section.desiredAccessLevel);

    // Clear intermediate state when section changes.
    this.autoDispose(_section.id.subscribe(() => this._reject()));
  }

  public buildDom() {
    // UI observables holder.
    const holder = new MultiHolder();

    // Show prompt, when desired access level is different from actual one.
    const prompt = Computed.create(holder, use =>
      use(this._desiredAccess)
      && !isSatisfied(use(this._currentAccess), use(this._desiredAccess)!));
    // If this is empty section or not.
    const isSelected = Computed.create(holder, use => Boolean(use(this._selectedId)));
    // If user is using custom url.
    const isCustom = Computed.create(holder, use => use(this._selectedId) === CUSTOM_ID || !this._canSelect);
    // Options for the select-box (all widgets definitions and Custom URL)
    const options = Computed.create(holder, use => [
      {label: 'Custom URL', value: 'custom'},
      ...use(this._widgets).map(w => ({label: w.name, value: w.widgetId})),
    ]);
    function buildPrompt(level: AccessLevel|null) {
      if (!level) {
        return null;
      }
      switch(level) {
        case AccessLevel.none: return cssConfirmLine(t("Widget does not require any permissions."));
        case AccessLevel.read_table:
          return cssConfirmLine(t("Widget needs to {{read}} the current table.", {read: dom("b", "read")}));
        case AccessLevel.full:
          return cssConfirmLine(t("Widget needs {{fullAccess}} to this document.", {
            fullAccess: dom("b", "full access")
          }));
        default: throw new Error(`Unsupported ${level} access level`);
      }
    }
    // Options for access level.
    const levels: IOptionFull<string>[] = [
      {label: t("No document access"), value: AccessLevel.none},
      {label: t("Read selected table"), value: AccessLevel.read_table},
      {label: t("Full document access"), value: AccessLevel.full},
    ];
    return dom(
      'div',
      dom.autoDispose(holder),
      this.shouldRenderWidgetSelector() &&
      this._canSelect
        ? cssRow(
          select(this._selectedId, options, {
            defaultLabel: t("Select Custom Widget"),
            menuCssClass: cssMenu.className,
          }),
          testId('select')
        )
        : null,
      dom.maybe(isCustom && this.shouldRenderWidgetSelector(), () => [
        cssRow(
          cssTextInput(
            this._url,
            async value => this._url.set(value),
            dom.attr('placeholder', t("Enter Custom URL")),
            testId('url')
          ),
          this._gristDoc.behavioralPromptsManager.attachTip('customURL', {
            popupOptions: {
              placement: 'left-start',
            },
            isDisabled: () => {
              // Disable tip if a custom widget is already selected.
              return Boolean(this._selectedId.get() && !(isCustom.get() && this._url.get().trim() === ''));
            },
          })
        ),
      ]),
      dom.maybe(prompt, () =>
        kf.prompt(
          {tabindex: '-1'},
          cssColumns(
            cssWarningWrapper(icon('Lock')),
            dom(
              'div',
              cssConfirmRow(
                dom.domComputed(this._desiredAccess, (level) => buildPrompt(level))
              ),
              cssConfirmRow(
                primaryButton(
                  'Accept',
                  testId('access-accept'),
                  dom.on('click', () => this._accept())
                ),
                basicButton(
                  'Reject',
                  testId('access-reject'),
                  dom.on('click', () => this._reject())
                )
              )
            )
          )
        )
      ),
      dom.maybe(
        use => use(isSelected) || !this._canSelect,
        () => [
          cssLabel('ACCESS LEVEL'),
          cssRow(select(this._currentAccess, levels), testId('access')),
        ]
      ),
      cssSection(
        cssLink(
          dom.attr('href', 'https://support.getgrist.com/widget-custom'),
          dom.attr('target', '_blank'),
          t("Learn more about custom widgets")
        )
      ),
      cssSeparator(),
      this._customSectionConfigurationConfig.buildDom(),
    );
  }

  protected shouldRenderWidgetSelector(): boolean {
    return true;
  }

  protected async _getWidgets() {
    const api = this._gristDoc.app.topAppModel.api;
    const wigets = await api.getWidgets();
    // Request for rest of the widgets.
    if (this._canSelect) {
      // From the start we will provide single widget definition
      // that was chosen previously.
      if (this._section.customDef.widgetDef.peek()) {
        wigets.push(this._section.customDef.widgetDef.peek()!);
      }
    }
    this._widgets.set(wigets);
  }



  private _accept() {
    if (this._desiredAccess.get()) {
      this._currentAccess.set(this._desiredAccess.get()!);
    }
    this._reject();
  }

  private _reject() {
    this._desiredAccess.set(null);
  }
}

const cssWarningWrapper = styled('div', `
  padding-left: 8px;
  padding-top: 6px;
  --icon-color: ${theme.iconError}
`);

const cssColumns = styled('div', `
  display: flex;
`);

const cssConfirmRow = styled('div', `
  display: flex;
  padding: 8px;
  gap: 8px;
`);

const cssConfirmLine = styled('span', `
  white-space: pre-wrap;
`);

const cssSection = styled('div', `
  margin: 16px 16px 12px 16px;
`);

const cssMenu = styled('div', `
  & > li:first-child {
    border-bottom: 1px solid ${theme.menuBorder};
  }
`);

const cssAddIcon = styled(icon, `
  margin-right: 4px;
`);

const cssRemoveIcon = styled(icon, `
  display: none;
  cursor: pointer;
  flex: none;
  margin-left: 8px;
  .${cssFieldEntry.className}:hover & {
    display: block;
  }
`);

// Additional text in label (greyed out)
const cssSubLabel = styled('span', `
  text-transform: none;
  font-size: ${vars.xsmallFontSize};
  color: ${theme.lightText};
`);

const cssAddMapping = styled('div', `
  display: flex;
  cursor: pointer;
  color: ${theme.controlFg};
  --icon-color: ${theme.controlFg};

  &:not(:first-child) {
    margin-top: 8px;
  }
  &:hover, &:focus, &:active {
    color: ${theme.controlHoverFg};
    --icon-color: ${theme.controlHoverFg};
  }
`);

const cssTextInput = styled(textInput, `
  flex: 1 0 auto;

  color: ${theme.inputFg};
  background-color: ${theme.inputBg};

  &:disabled {
    color: ${theme.inputDisabledFg};
    background-color: ${theme.inputDisabledBg};
    pointer-events: none;
  }

  &::placeholder {
    color: ${theme.inputPlaceholderFg};
  }
`);
