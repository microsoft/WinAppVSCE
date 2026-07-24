/**
 * Static WinUI 3 and XAML metadata used by the XAML language server.
 */
export interface PropertyInfo {
	name: string;
	type: string;
	description: string;
	values?: string[];
	isEvent?: boolean;
	isAttached?: boolean;
	ownerType?: string;
}

export interface TypeInfo {
	name: string;
	namespace: string;
	description: string;
	baseType?: string;
	properties: PropertyInfo[];
	events: PropertyInfo[];
	contentProperty?: string;
}

export interface NamespaceInfo {
	uri: string;
	prefix: string;
	types: string[];
}

const PRESENTATION_URI = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';
const XAML_URI = 'http://schemas.microsoft.com/winfx/2006/xaml';
const DESIGN_URI = 'http://schemas.microsoft.com/expression/blend/2008';
const MC_URI = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

const enumValues = {
	HorizontalAlignment: ['Left', 'Center', 'Right', 'Stretch'],
	VerticalAlignment: ['Top', 'Center', 'Bottom', 'Stretch'],
	Visibility: ['Visible', 'Collapsed'],
	Orientation: ['Horizontal', 'Vertical'],
	Stretch: ['None', 'Fill', 'Uniform', 'UniformToFill'],
	TextWrapping: ['NoWrap', 'Wrap', 'WrapWholeWords'],
	TextAlignment: ['Left', 'Center', 'Right', 'Justify'],
	ScrollBarVisibility: ['Disabled', 'Auto', 'Hidden', 'Visible'],
	Placement: ['Top', 'Bottom', 'Left', 'Right', 'Center'],
	SelectionMode: ['None', 'Single', 'Multiple', 'Extended'],
	CommandBarLabelPosition: ['Default', 'Right', 'Collapsed'],
	TeachingTipPlacement: ['Auto', 'Top', 'Bottom', 'Left', 'Right', 'Center'],
	InfoBarSeverity: ['Informational', 'Success', 'Warning', 'Error'],
	NavigationViewDisplayMode: ['Minimal', 'Compact', 'Expanded'],
	NavigationViewPaneDisplayMode: ['Auto', 'Left', 'Top', 'LeftCompact', 'LeftMinimal'],
	ProgressBarShowPaused: ['True', 'False'],
	FontWeight: ['Thin', 'ExtraLight', 'Light', 'Normal', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black']
} as const;

const commonBrushes = [
	'Transparent', 'White', 'Black', 'Red', 'Green', 'Blue', 'Gray', 'LightGray',
	'DarkGray', 'Yellow', 'Orange', 'Purple', 'Pink', 'Brown', 'Cyan', 'Magenta'
];

const themeResources = [
	'SystemAccentColor',
	'SystemAccentColorDark1',
	'SystemAccentColorDark2',
	'SystemAccentColorDark3',
	'SystemAccentColorLight1',
	'SystemAccentColorLight2',
	'SystemAccentColorLight3',
	'SystemBaseHighColor',
	'SystemBaseMediumHighColor',
	'SystemBaseMediumColor',
	'SystemBaseMediumLowColor',
	'SystemBaseLowColor',
	'SystemChromeMediumColor',
	'SystemChromeHighColor',
	'SystemChromeLowColor',
	'SystemAltHighColor',
	'TextFillColorPrimaryBrush',
	'TextFillColorSecondaryBrush',
	'ControlFillColorDefaultBrush',
	'ControlStrongFillColorDefaultBrush',
	'CardBackgroundFillColorDefaultBrush',
	'AccentFillColorDefaultBrush'
];

function property(name: string, type: string, description: string, values?: string[]): PropertyInfo {
	return { name, type, description, values };
}

function eventInfo(name: string, description: string): PropertyInfo {
	return { name, type: 'event', description, isEvent: true };
}

function attached(name: string, type: string, description: string, ownerType: string, values?: string[]): PropertyInfo {
	return { name, type, description, ownerType, values, isAttached: true };
}

function typeInfo(info: TypeInfo): TypeInfo {
	return info;
}

const uiElementProperties: PropertyInfo[] = [
	property('Visibility', 'Visibility', 'Controls whether the element is visible.', [...enumValues.Visibility]),
	property('Opacity', 'number', 'Sets the opacity of the element from 0 to 1.'),
	property('IsHitTestVisible', 'boolean', 'Controls whether the element can receive pointer input.'),
	property('AllowDrop', 'boolean', 'Enables drag and drop on the element.')
];

const frameworkElementProperties: PropertyInfo[] = [
	property('Width', 'number', 'Sets the element width.'),
	property('Height', 'number', 'Sets the element height.'),
	property('MinWidth', 'number', 'Sets the minimum element width.'),
	property('MinHeight', 'number', 'Sets the minimum element height.'),
	property('MaxWidth', 'number', 'Sets the maximum element width.'),
	property('MaxHeight', 'number', 'Sets the maximum element height.'),
	property('Margin', 'Thickness', 'Sets the outer margin.'),
	property('HorizontalAlignment', 'HorizontalAlignment', 'Aligns the element horizontally.', [...enumValues.HorizontalAlignment]),
	property('VerticalAlignment', 'VerticalAlignment', 'Aligns the element vertically.', [...enumValues.VerticalAlignment]),
	property('FlowDirection', 'FlowDirection', 'Sets left-to-right or right-to-left layout.'),
	property('RequestedTheme', 'ElementTheme', 'Overrides the requested theme for the element.', ['Default', 'Light', 'Dark']),
	property('Style', 'Style', 'Applies a style resource.'),
	property('Tag', 'object', 'Stores custom application data on the element.'),
	property('DataContext', 'object', 'Provides the binding context for descendant elements.'),
	property('x:Name', 'string', 'Declares a runtime name for the element.'),
	property('x:Key', 'string', 'Declares a resource key for the element.')
];

const controlProperties: PropertyInfo[] = [
	property('Padding', 'Thickness', 'Sets the inner padding.'),
	property('Background', 'Brush', 'Sets the background brush.', commonBrushes),
	property('Foreground', 'Brush', 'Sets the foreground brush.', commonBrushes),
	property('BorderBrush', 'Brush', 'Sets the border brush.', commonBrushes),
	property('BorderThickness', 'Thickness', 'Sets the border thickness.'),
	property('CornerRadius', 'CornerRadius', 'Sets the corner radius.'),
	property('FontSize', 'number', 'Sets the font size.'),
	property('FontFamily', 'string', 'Sets the font family.'),
	property('FontWeight', 'FontWeight', 'Sets the font weight.', [...enumValues.FontWeight]),
	property('IsEnabled', 'boolean', 'Controls whether the control is enabled.'),
	property('TabIndex', 'number', 'Sets keyboard tab order.')
];

const contentControlProperties: PropertyInfo[] = [
	property('Content', 'object', 'Gets or sets the control content.'),
	property('ContentTemplate', 'DataTemplate', 'Sets the template used for the content.'),
	property('HorizontalContentAlignment', 'HorizontalAlignment', 'Aligns content horizontally.', [...enumValues.HorizontalAlignment]),
	property('VerticalContentAlignment', 'VerticalAlignment', 'Aligns content vertically.', [...enumValues.VerticalAlignment])
];

const itemsControlProperties: PropertyInfo[] = [
	property('ItemsSource', 'object', 'Binds the item source collection.'),
	property('ItemTemplate', 'DataTemplate', 'Sets the item template.'),
	property('ItemsPanel', 'ItemsPanelTemplate', 'Sets the panel used to display items.'),
	property('Header', 'object', 'Sets header content.'),
	property('HeaderTemplate', 'DataTemplate', 'Sets the header template.')
];

const selectorProperties: PropertyInfo[] = [
	property('SelectedIndex', 'number', 'Gets or sets the selected item index.'),
	property('SelectedItem', 'object', 'Gets or sets the selected item.'),
	property('SelectedValue', 'object', 'Gets or sets the selected value.'),
	property('SelectionMode', 'SelectionMode', 'Sets how many items can be selected.', [...enumValues.SelectionMode])
];

const textBoxBaseProperties: PropertyInfo[] = [
	property('AcceptsReturn', 'boolean', 'Controls whether Enter inserts a new line.'),
	property('IsReadOnly', 'boolean', 'Controls whether the user can edit the text.'),
	property('PlaceholderText', 'string', 'Sets the placeholder text.')
];

const rangeBaseProperties: PropertyInfo[] = [
	property('Minimum', 'number', 'Sets the minimum value.'),
	property('Maximum', 'number', 'Sets the maximum value.'),
	property('Value', 'number', 'Sets the current value.'),
	property('StepFrequency', 'number', 'Sets the change step value.'),
	property('SmallChange', 'number', 'Sets keyboard/small change value.'),
	property('LargeChange', 'number', 'Sets page/large change value.')
];

const types: TypeInfo[] = [
	typeInfo({
		name: 'UIElement',
		namespace: PRESENTATION_URI,
		description: 'Base class for all WinUI visual elements.',
		properties: uiElementProperties,
		events: [
			eventInfo('Tapped', 'Raised when the element is tapped.'),
			eventInfo('Loaded', 'Raised when the element is loaded.')
		]
	}),
	typeInfo({
		name: 'FrameworkElement',
		namespace: PRESENTATION_URI,
		description: 'Base class for framework-level layout and data binding support.',
		baseType: 'UIElement',
		properties: frameworkElementProperties,
		events: [eventInfo('SizeChanged', 'Raised when the element size changes.')]
	}),
	typeInfo({
		name: 'Control',
		namespace: PRESENTATION_URI,
		description: 'Base class for reusable templated controls.',
		baseType: 'FrameworkElement',
		properties: controlProperties,
		events: [eventInfo('GotFocus', 'Raised when the control gets focus.')]
	}),
	typeInfo({
		name: 'ContentControl',
		namespace: PRESENTATION_URI,
		description: 'Base class for controls with a single content property.',
		baseType: 'Control',
		properties: contentControlProperties,
		events: [],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'Panel',
		namespace: PRESENTATION_URI,
		description: 'Base class for layout containers.',
		baseType: 'FrameworkElement',
		properties: [
			property('Background', 'Brush', 'Sets the panel background brush.', commonBrushes),
			property('Spacing', 'number', 'Sets the spacing between arranged children.')
		],
		events: [],
		contentProperty: 'Children'
	}),
	typeInfo({
		name: 'ItemsControl',
		namespace: PRESENTATION_URI,
		description: 'Base class for controls that present collections of items.',
		baseType: 'Control',
		properties: itemsControlProperties,
		events: [],
		contentProperty: 'Items'
	}),
	typeInfo({
		name: 'Selector',
		namespace: PRESENTATION_URI,
		description: 'Base class for controls that support selection.',
		baseType: 'ItemsControl',
		properties: selectorProperties,
		events: [eventInfo('SelectionChanged', 'Raised when the selection changes.')]
	}),
	typeInfo({
		name: 'TextBoxBase',
		namespace: PRESENTATION_URI,
		description: 'Base class for text editing controls.',
		baseType: 'Control',
		properties: textBoxBaseProperties,
		events: [eventInfo('TextChanged', 'Raised when the text changes.')]
	}),
	typeInfo({
		name: 'RangeBase',
		namespace: PRESENTATION_URI,
		description: 'Base class for controls that expose a numeric range.',
		baseType: 'Control',
		properties: rangeBaseProperties,
		events: [eventInfo('ValueChanged', 'Raised when the control value changes.')]
	}),
	typeInfo({
		name: 'Grid',
		namespace: PRESENTATION_URI,
		description: 'Arranges children in rows and columns.',
		baseType: 'Panel',
		properties: [
			property('RowSpacing', 'number', 'Sets the space between rows.'),
			property('ColumnSpacing', 'number', 'Sets the space between columns.'),
			attached('Row', 'number', 'Specifies the row for a child element.', 'Grid'),
			attached('Column', 'number', 'Specifies the column for a child element.', 'Grid'),
			attached('RowSpan', 'number', 'Specifies how many rows a child spans.', 'Grid'),
			attached('ColumnSpan', 'number', 'Specifies how many columns a child spans.', 'Grid')
		],
		events: [],
		contentProperty: 'Children'
	}),
	typeInfo({
		name: 'StackPanel',
		namespace: PRESENTATION_URI,
		description: 'Stacks child elements vertically or horizontally.',
		baseType: 'Panel',
		properties: [
			property('Orientation', 'Orientation', 'Sets the stacking direction.', [...enumValues.Orientation])
		],
		events: [],
		contentProperty: 'Children'
	}),
	typeInfo({
		name: 'RelativePanel',
		namespace: PRESENTATION_URI,
		description: 'Arranges children relative to each other or the panel.',
		baseType: 'Panel',
		properties: [
			attached('AlignLeftWithPanel', 'boolean', 'Aligns the child to the left side of the panel.', 'RelativePanel'),
			attached('AlignTopWithPanel', 'boolean', 'Aligns the child to the top of the panel.', 'RelativePanel'),
			attached('AlignRightWithPanel', 'boolean', 'Aligns the child to the right side of the panel.', 'RelativePanel'),
			attached('AlignBottomWithPanel', 'boolean', 'Aligns the child to the bottom side of the panel.', 'RelativePanel'),
			attached('RightOf', 'string', 'Positions the child to the right of another child by name.', 'RelativePanel'),
			attached('Below', 'string', 'Positions the child below another child by name.', 'RelativePanel')
		],
		events: [],
		contentProperty: 'Children'
	}),
	typeInfo({
		name: 'Canvas',
		namespace: PRESENTATION_URI,
		description: 'Positions children using explicit coordinates.',
		baseType: 'Panel',
		properties: [
			attached('Left', 'number', 'Sets the left coordinate for a child.', 'Canvas'),
			attached('Top', 'number', 'Sets the top coordinate for a child.', 'Canvas'),
			attached('ZIndex', 'number', 'Sets the z-order for a child.', 'Canvas')
		],
		events: [],
		contentProperty: 'Children'
	}),
	typeInfo({
		name: 'Border',
		namespace: PRESENTATION_URI,
		description: 'Draws a border and background around a single child.',
		baseType: 'FrameworkElement',
		properties: [
			property('Background', 'Brush', 'Sets the border background brush.', commonBrushes),
			property('BorderBrush', 'Brush', 'Sets the border brush.', commonBrushes),
			property('BorderThickness', 'Thickness', 'Sets the border thickness.'),
			property('CornerRadius', 'CornerRadius', 'Sets the corner radius.'),
			property('Padding', 'Thickness', 'Sets the inner padding.'),
			property('Child', 'UIElement', 'Gets or sets the single child element.')
		],
		events: [],
		contentProperty: 'Child'
	}),
	typeInfo({
		name: 'ScrollViewer',
		namespace: PRESENTATION_URI,
		description: 'Adds scrolling and zooming around a single content element.',
		baseType: 'ContentControl',
		properties: [
			property('HorizontalScrollBarVisibility', 'ScrollBarVisibility', 'Controls the horizontal scroll bar.', [...enumValues.ScrollBarVisibility]),
			property('VerticalScrollBarVisibility', 'ScrollBarVisibility', 'Controls the vertical scroll bar.', [...enumValues.ScrollBarVisibility]),
			property('ZoomMode', 'ZoomMode', 'Controls zoom support.', ['Disabled', 'Enabled']),
			property('IsDeferredScrollingEnabled', 'boolean', 'Defers content updates while dragging the thumb.')
		],
		events: [eventInfo('ViewChanged', 'Raised when the view position changes.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'Button',
		namespace: PRESENTATION_URI,
		description: 'Represents a standard push button control.',
		baseType: 'ContentControl',
		properties: [
			property('Command', 'ICommand', 'Binds an ICommand to the button.'),
			property('CommandParameter', 'object', 'Sets the command parameter.')
		],
		events: [eventInfo('Click', 'Raised when the button is clicked.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'TextBlock',
		namespace: PRESENTATION_URI,
		description: 'Displays text content.',
		baseType: 'FrameworkElement',
		properties: [
			property('Text', 'string', 'Sets the displayed text.'),
			property('TextWrapping', 'TextWrapping', 'Controls line wrapping.', [...enumValues.TextWrapping]),
			property('TextAlignment', 'TextAlignment', 'Aligns the text.', [...enumValues.TextAlignment]),
			property('Foreground', 'Brush', 'Sets the text brush.', commonBrushes),
			property('FontSize', 'number', 'Sets the font size.'),
			property('FontFamily', 'string', 'Sets the font family.'),
			property('FontWeight', 'FontWeight', 'Sets the font weight.', [...enumValues.FontWeight]),
			property('MaxLines', 'number', 'Limits the number of displayed lines.')
		],
		events: [],
		contentProperty: 'Inlines'
	}),
	typeInfo({
		name: 'TextBox',
		namespace: PRESENTATION_URI,
		description: 'Allows the user to enter plain text.',
		baseType: 'TextBoxBase',
		properties: [
			property('Text', 'string', 'Gets or sets the current text.'),
			property('TextWrapping', 'TextWrapping', 'Controls line wrapping.', [...enumValues.TextWrapping]),
			property('MaxLength', 'number', 'Limits the number of characters.')
		],
		events: [eventInfo('BeforeTextChanging', 'Raised before the text changes.')]
	}),
	typeInfo({
		name: 'ComboBox',
		namespace: PRESENTATION_URI,
		description: 'Lets the user select a value from a drop-down list.',
		baseType: 'Selector',
		properties: [
			property('IsEditable', 'boolean', 'Controls whether the text box is editable.'),
			property('PlaceholderText', 'string', 'Sets the placeholder text.'),
			property('DisplayMemberPath', 'string', 'Gets or sets the property used to display items.')
		],
		events: [eventInfo('DropDownOpened', 'Raised when the drop-down opens.')],
		contentProperty: 'Items'
	}),
	typeInfo({
		name: 'ListView',
		namespace: PRESENTATION_URI,
		description: 'Displays a list of selectable items.',
		baseType: 'Selector',
		properties: [
			property('IsItemClickEnabled', 'boolean', 'Controls whether items raise click events.'),
			property('SelectionMode', 'SelectionMode', 'Sets the selection mode.', [...enumValues.SelectionMode]),
			property('DisplayMemberPath', 'string', 'Gets or sets the display path.')
		],
		events: [eventInfo('ItemClick', 'Raised when an item is clicked.')],
		contentProperty: 'Items'
	}),
	typeInfo({
		name: 'CheckBox',
		namespace: PRESENTATION_URI,
		description: 'Represents a check box control.',
		baseType: 'ContentControl',
		properties: [
			property('IsChecked', 'boolean', 'Gets or sets the checked state.'),
			property('IsThreeState', 'boolean', 'Enables the indeterminate state.')
		],
		events: [eventInfo('Checked', 'Raised when checked.'), eventInfo('Unchecked', 'Raised when unchecked.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'RadioButton',
		namespace: PRESENTATION_URI,
		description: 'Represents a mutually exclusive option button.',
		baseType: 'ContentControl',
		properties: [
			property('IsChecked', 'boolean', 'Gets or sets the checked state.'),
			property('GroupName', 'string', 'Gets or sets the group name.')
		],
		events: [eventInfo('Checked', 'Raised when checked.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'ToggleSwitch',
		namespace: PRESENTATION_URI,
		description: 'Represents an on/off switch.',
		baseType: 'Control',
		properties: [
			property('IsOn', 'boolean', 'Gets or sets whether the switch is on.'),
			property('Header', 'object', 'Gets or sets the header content.'),
			property('OnContent', 'object', 'Gets or sets content shown when on.'),
			property('OffContent', 'object', 'Gets or sets content shown when off.')
		],
		events: [eventInfo('Toggled', 'Raised when the switch is toggled.')]
	}),
	typeInfo({
		name: 'Slider',
		namespace: PRESENTATION_URI,
		description: 'Represents a value selector with a draggable thumb.',
		baseType: 'RangeBase',
		properties: [
			property('Orientation', 'Orientation', 'Sets the slider orientation.', [...enumValues.Orientation]),
			property('IsThumbToolTipEnabled', 'boolean', 'Shows the thumb tooltip when dragging.')
		],
		events: []
	}),
	typeInfo({
		name: 'ProgressBar',
		namespace: PRESENTATION_URI,
		description: 'Shows linear progress for a task.',
		baseType: 'RangeBase',
		properties: [
			property('IsIndeterminate', 'boolean', 'Shows an indeterminate animation.'),
			property('ShowError', 'boolean', 'Shows the error visual state.', [...enumValues.ProgressBarShowPaused]),
			property('ShowPaused', 'boolean', 'Shows the paused visual state.', [...enumValues.ProgressBarShowPaused])
		],
		events: []
	}),
	typeInfo({
		name: 'ProgressRing',
		namespace: PRESENTATION_URI,
		description: 'Shows circular progress for a task.',
		baseType: 'Control',
		properties: [
			property('IsActive', 'boolean', 'Controls whether the ring animates.'),
			property('Value', 'number', 'Gets or sets determinate progress value.'),
			property('Maximum', 'number', 'Sets the maximum determinate value.'),
			property('IsIndeterminate', 'boolean', 'Shows the indeterminate ring animation.')
		],
		events: []
	}),
	typeInfo({
		name: 'Image',
		namespace: PRESENTATION_URI,
		description: 'Displays a bitmap or vector image.',
		baseType: 'FrameworkElement',
		properties: [
			property('Source', 'ImageSource', 'Gets or sets the image source URI or object.'),
			property('Stretch', 'Stretch', 'Controls how the image fills the available space.', [...enumValues.Stretch])
		],
		events: [eventInfo('ImageOpened', 'Raised when the image loads successfully.')]
	}),
	typeInfo({
		name: 'NavigationView',
		namespace: PRESENTATION_URI,
		description: 'Provides a top-level application navigation container.',
		baseType: 'ContentControl',
		properties: [
			property('PaneDisplayMode', 'NavigationViewPaneDisplayMode', 'Controls how the pane is shown.', [...enumValues.NavigationViewPaneDisplayMode]),
			property('DisplayMode', 'NavigationViewDisplayMode', 'Gets the current display mode.', [...enumValues.NavigationViewDisplayMode]),
			property('IsBackButtonVisible', 'NavigationViewBackButtonVisible', 'Controls back button visibility.', ['Auto', 'Visible', 'Collapsed']),
			property('IsSettingsVisible', 'boolean', 'Controls whether the Settings item is shown.'),
			property('MenuItemsSource', 'object', 'Gets or sets the primary menu items source.'),
			property('SelectedItem', 'object', 'Gets or sets the selected item.')
		],
		events: [eventInfo('SelectionChanged', 'Raised when the selected item changes.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'TabView',
		namespace: PRESENTATION_URI,
		description: 'Displays tabs that host user-selected content.',
		baseType: 'Control',
		properties: [
			property('TabItemsSource', 'object', 'Gets or sets the tab items source.'),
			property('SelectedItem', 'object', 'Gets or sets the selected tab item.'),
			property('CanCloseTabs', 'boolean', 'Controls whether tabs can be closed.')
		],
		events: [eventInfo('TabCloseRequested', 'Raised when a tab close is requested.')],
		contentProperty: 'TabItems'
	}),
	typeInfo({
		name: 'InfoBar',
		namespace: PRESENTATION_URI,
		description: 'Displays an inline message with optional actions.',
		baseType: 'Control',
		properties: [
			property('Title', 'string', 'Gets or sets the title text.'),
			property('Message', 'string', 'Gets or sets the body message.'),
			property('Severity', 'InfoBarSeverity', 'Controls the visual style of the bar.', [...enumValues.InfoBarSeverity]),
			property('IsOpen', 'boolean', 'Controls whether the InfoBar is visible.'),
			property('IsClosable', 'boolean', 'Controls whether the close button is shown.')
		],
		events: [eventInfo('CloseButtonClick', 'Raised when the close button is clicked.')]
	}),
	typeInfo({
		name: 'TeachingTip',
		namespace: PRESENTATION_URI,
		description: 'Displays contextual UI anchored to another control.',
		baseType: 'ContentControl',
		properties: [
			property('Title', 'string', 'Gets or sets the teaching tip title.'),
			property('Subtitle', 'string', 'Gets or sets the teaching tip subtitle.'),
			property('IsOpen', 'boolean', 'Controls whether the teaching tip is open.'),
			property('Placement', 'TeachingTipPlacementMode', 'Controls tip placement.', [...enumValues.TeachingTipPlacement]),
			property('Target', 'FrameworkElement', 'Gets or sets the target element.')
		],
		events: [eventInfo('ActionButtonClick', 'Raised when the action button is clicked.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'MenuBar',
		namespace: PRESENTATION_URI,
		description: 'Displays a horizontal list of top-level menu items.',
		baseType: 'Control',
		properties: [],
		events: [],
		contentProperty: 'Items'
	}),
	typeInfo({
		name: 'CommandBar',
		namespace: PRESENTATION_URI,
		description: 'Hosts app commands in a primary or secondary bar.',
		baseType: 'Control',
		properties: [
			property('DefaultLabelPosition', 'CommandBarLabelPosition', 'Controls command label placement.', [...enumValues.CommandBarLabelPosition]),
			property('IsDynamicOverflowEnabled', 'boolean', 'Enables moving commands to overflow.')
		],
		events: [],
		contentProperty: 'PrimaryCommands'
	}),
	typeInfo({
		name: 'AutoSuggestBox',
		namespace: PRESENTATION_URI,
		description: 'Provides text entry with suggestion support.',
		baseType: 'ItemsControl',
		properties: [
			property('Text', 'string', 'Gets or sets the text.'),
			property('PlaceholderText', 'string', 'Gets or sets the placeholder text.'),
			property('QueryIcon', 'IconElement', 'Gets or sets the icon shown in the box.'),
			property('UpdateTextOnSelect', 'boolean', 'Updates the text when a suggestion is selected.')
		],
		events: [eventInfo('TextChanged', 'Raised when the text changes.'), eventInfo('SuggestionChosen', 'Raised when a suggestion is chosen.')]
	}),
	typeInfo({
		name: 'CalendarDatePicker',
		namespace: PRESENTATION_URI,
		description: 'Lets the user pick a date from a calendar flyout.',
		baseType: 'Control',
		properties: [
			property('Date', 'DateTimeOffset', 'Gets or sets the selected date.'),
			property('PlaceholderText', 'string', 'Gets or sets the placeholder text.'),
			property('MinDate', 'DateTimeOffset', 'Gets or sets the minimum date.'),
			property('MaxDate', 'DateTimeOffset', 'Gets or sets the maximum date.')
		],
		events: [eventInfo('DateChanged', 'Raised when the selected date changes.')]
	}),
	typeInfo({
		name: 'DatePicker',
		namespace: PRESENTATION_URI,
		description: 'Lets the user select a date using month/day/year selectors.',
		baseType: 'Control',
		properties: [
			property('Date', 'DateTimeOffset', 'Gets or sets the selected date.'),
			property('MinYear', 'DateTimeOffset', 'Gets or sets the minimum year.'),
			property('MaxYear', 'DateTimeOffset', 'Gets or sets the maximum year.')
		],
		events: [eventInfo('DateChanged', 'Raised when the selected date changes.')]
	}),
	typeInfo({
		name: 'TimePicker',
		namespace: PRESENTATION_URI,
		description: 'Lets the user select a time value.',
		baseType: 'Control',
		properties: [
			property('Time', 'TimeSpan', 'Gets or sets the selected time.'),
			property('ClockIdentifier', 'string', 'Sets the clock format identifier.')
		],
		events: [eventInfo('TimeChanged', 'Raised when the selected time changes.')]
	}),
	typeInfo({
		name: 'NumberBox',
		namespace: PRESENTATION_URI,
		description: 'Lets the user enter or spin a numeric value.',
		baseType: 'Control',
		properties: [
			property('Value', 'number', 'Gets or sets the current value.'),
			property('Minimum', 'number', 'Gets or sets the minimum value.'),
			property('Maximum', 'number', 'Gets or sets the maximum value.'),
			property('SmallChange', 'number', 'Gets or sets the small change value.'),
			property('LargeChange', 'number', 'Gets or sets the large change value.'),
			property('PlaceholderText', 'string', 'Gets or sets the placeholder text.')
		],
		events: [eventInfo('ValueChanged', 'Raised when the value changes.')]
	}),
	typeInfo({
		name: 'PasswordBox',
		namespace: PRESENTATION_URI,
		description: 'Allows the user to enter masked text.',
		baseType: 'Control',
		properties: [
			property('Password', 'string', 'Gets or sets the password text.'),
			property('PlaceholderText', 'string', 'Gets or sets the placeholder text.'),
			property('PasswordRevealMode', 'PasswordRevealMode', 'Controls password reveal.', ['Peek', 'Hidden', 'Visible'])
		],
		events: [eventInfo('PasswordChanged', 'Raised when the password changes.')]
	}),
	typeInfo({
		name: 'RichEditBox',
		namespace: PRESENTATION_URI,
		description: 'Provides rich text editing capabilities.',
		baseType: 'TextBoxBase',
		properties: [
			property('IsSpellCheckEnabled', 'boolean', 'Enables spell checking.'),
			property('TextWrapping', 'TextWrapping', 'Controls line wrapping.', [...enumValues.TextWrapping]),
			property('Document', 'ITextDocument', 'Gets the backing rich text document.')
		],
		events: [eventInfo('SelectionChanged', 'Raised when the selection changes.')]
	}),
	typeInfo({
		name: 'Page',
		namespace: PRESENTATION_URI,
		description: 'Represents a navigable page in a frame-based app.',
		baseType: 'UserControl',
		properties: [
			property('Background', 'Brush', 'Sets the page background brush.', commonBrushes)
		],
		events: [eventInfo('NavigatedTo', 'Raised when navigation arrives at the page.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'Window',
		namespace: PRESENTATION_URI,
		description: 'Represents a top-level desktop window.',
		baseType: 'ContentControl',
		properties: [
			property('Title', 'string', 'Gets or sets the window title.'),
			property('ExtendsContentIntoTitleBar', 'boolean', 'Controls whether content extends into the title bar.')
		],
		events: [eventInfo('Activated', 'Raised when the window activation state changes.')],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'UserControl',
		namespace: PRESENTATION_URI,
		description: 'Represents a reusable chunk of UI content.',
		baseType: 'ContentControl',
		properties: [],
		events: [],
		contentProperty: 'Content'
	}),
	typeInfo({
		name: 'ResourceDictionary',
		namespace: PRESENTATION_URI,
		description: 'Stores keyed resources such as brushes, styles, and templates.',
		baseType: 'FrameworkElement',
		properties: [
			property('Source', 'Uri', 'Loads resources from another XAML dictionary.')
		],
		events: [],
		contentProperty: 'MergedDictionaries'
	}),
	typeInfo({
		name: 'Style',
		namespace: PRESENTATION_URI,
		description: 'Represents a reusable set of property setters.',
		baseType: 'FrameworkElement',
		properties: [
			property('TargetType', 'string', 'Specifies the type the style targets.'),
			property('BasedOn', 'Style', 'References a base style.')
		],
		events: [],
		contentProperty: 'Setters'
	}),
	typeInfo({
		name: 'DataTemplate',
		namespace: PRESENTATION_URI,
		description: 'Defines the visual tree used to display bound data.',
		baseType: 'FrameworkElement',
		properties: [
			property('x:DataType', 'string', 'Provides compile-time binding type information.')
		],
		events: [],
		contentProperty: 'VisualTree'
	}),
	typeInfo({
		name: 'VisualStateManager',
		namespace: PRESENTATION_URI,
		description: 'Coordinates visual states and transitions for controls.',
		baseType: 'FrameworkElement',
		properties: [],
		events: [],
		contentProperty: 'VisualStateGroups'
	}),
	typeInfo({
		name: 'Bind',
		namespace: XAML_URI,
		description: 'Represents the x:Bind markup extension for compiled bindings.',
		properties: [
			property('Path', 'string', 'Gets the binding path.'),
			property('Mode', 'BindingMode', 'Sets the binding mode.', ['OneTime', 'OneWay', 'TwoWay'])
		],
		events: []
	}),
	typeInfo({
		name: 'Null',
		namespace: XAML_URI,
		description: 'Represents the x:Null markup extension.',
		properties: [],
		events: []
	}),
	typeInfo({
		name: 'String',
		namespace: XAML_URI,
		description: 'Represents an x:String object in XAML.',
		properties: [],
		events: [],
		contentProperty: 'Text'
	}),
	typeInfo({
		name: 'Boolean',
		namespace: XAML_URI,
		description: 'Represents an x:Boolean object in XAML.',
		properties: [],
		events: []
	}),
	typeInfo({
		name: 'Int32',
		namespace: XAML_URI,
		description: 'Represents an x:Int32 object in XAML.',
		properties: [],
		events: []
	})
];

const namespaces: NamespaceInfo[] = [
	{
		uri: PRESENTATION_URI,
		prefix: '',
		types: types.filter((type) => type.namespace === PRESENTATION_URI).map((type) => type.name)
	},
	{
		uri: XAML_URI,
		prefix: 'x',
		types: types.filter((type) => type.namespace === XAML_URI).map((type) => `x:${type.name}`)
	},
	{ uri: DESIGN_URI, prefix: 'd', types: [] },
	{ uri: MC_URI, prefix: 'mc', types: [] }
];

const typeMap = new Map<string, TypeInfo>();
for (const info of types) {
	typeMap.set(info.name, info);
	typeMap.set(`${info.namespace}:${info.name}`, info);
	if (info.namespace === XAML_URI) {
		typeMap.set(`x:${info.name}`, info);
	}
}

function getBaseChain(typeName: string): TypeInfo[] {
	const result: TypeInfo[] = [];
	const seen = new Set<string>();
	let current = getTypeByName(typeName);
	while (current && !seen.has(current.name)) {
		result.unshift(current);
		seen.add(current.name);
		current = current.baseType ? getTypeByName(current.baseType) : undefined;
	}
	return result;
}

/**
 * Gets the complete set of known WinUI and XAML types.
 */
export function getWinUITypes(): Map<string, TypeInfo> {
	return typeMap;
}

/**
 * Gets the known XML namespaces used by WinUI XAML.
 */
export function getNamespaces(): NamespaceInfo[] {
	return namespaces;
}

/**
 * Resolves a type by simple or prefixed name.
 */
export function getTypeByName(name: string): TypeInfo | undefined {
	const normalized = name.includes(':') ? name : name.trim();
	return typeMap.get(normalized) ?? typeMap.get(normalized.split(':').pop() ?? normalized);
}

/**
 * Gets a flattened property list including inherited members.
 */
export function getAllPropertiesForType(typeName: string): PropertyInfo[] {
	const chain = getBaseChain(typeName);
	const resolved = new Map<string, PropertyInfo>();
	for (const info of chain) {
		for (const member of info.properties) {
			const key = member.isAttached ? `${member.ownerType}.${member.name}` : member.name;
			resolved.set(key, member);
		}
	}
	return [...resolved.values()];
}

/**
 * Gets a flattened event list including inherited events.
 */
export function getAllEventsForType(typeName: string): PropertyInfo[] {
	const chain = getBaseChain(typeName);
	const resolved = new Map<string, PropertyInfo>();
	for (const info of chain) {
		for (const member of info.events) {
			resolved.set(member.name, member);
		}
	}
	return [...resolved.values()];
}

/**
 * Finds a property or event on a type, including inherited members and known attached properties.
 */
export function findPropertyInfo(typeName: string, attributeName: string): PropertyInfo | undefined {
	const allProperties = getAllPropertiesForType(typeName);
	const allEvents = getAllEventsForType(typeName);
	const normalized = attributeName.trim();
	const dotIndex = normalized.indexOf('.');
	if (dotIndex >= 0) {
		const ownerType = normalized.slice(0, dotIndex);
		const propertyName = normalized.slice(dotIndex + 1);
		return getAllPropertiesForType(ownerType).find(
			(property) => property.isAttached && property.ownerType === ownerType && property.name === propertyName
		);
	}

	return allProperties.find((property) => property.name === normalized)
		?? allEvents.find((eventMember) => eventMember.name === normalized);
}

/**
 * Gets the globally known attached properties.
 */
export function getAttachedProperties(): PropertyInfo[] {
	return types.flatMap((info) => info.properties.filter((property) => property.isAttached));
}

/**
 * Gets common brush and named color suggestions.
 */
export function getCommonBrushes(): string[] {
	return commonBrushes;
}

/**
 * Gets common built-in theme resource keys.
 */
export function getThemeResources(): string[] {
	return themeResources;
}
