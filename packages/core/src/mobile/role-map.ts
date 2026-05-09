export const ANDROID_ROLE_MAP: Record<string, string> = {
  'android.widget.Button': 'button',
  'android.widget.ImageButton': 'button',
  'android.widget.EditText': 'textbox',
  'android.widget.AutoCompleteTextView': 'textbox',
  'android.widget.TextView': 'text',
  'android.widget.CheckedTextView': 'text',
  'android.widget.CheckBox': 'checkbox',
  'android.widget.Switch': 'switch',
  'android.widget.ImageView': 'image',
  'android.widget.ListView': 'list',
  'android.widget.ScrollView': 'scroll-area',
  'android.widget.HorizontalScrollView': 'scroll-area',
  'android.view.View': 'group',
  'android.view.ViewGroup': 'group',
  'android.widget.FrameLayout': 'group',
  'android.widget.LinearLayout': 'group',
  'android.widget.RelativeLayout': 'group',
  'android.widget.SearchView': 'searchbox',
  'android.widget.Spinner': 'combobox',
  'android.widget.SeekBar': 'slider',
  'android.widget.RadioButton': 'radio',
  'android.widget.CompoundButton': 'button',
  'android.widget.ToggleButton': 'button',
  'android.widget.ProgressBar': 'progressbar',
  'android.widget.Toolbar': 'toolbar',
  'android.widget.TabWidget': 'tablist',
  'android.webkit.WebView': 'webview',
  'androidx.recyclerview.widget.RecyclerView': 'list',
  'androidx.constraintlayout.widget.ConstraintLayout': 'group',
  'androidx.appcompat.widget.Toolbar': 'toolbar',
  'androidx.viewpager.widget.ViewPager': 'group',
  'androidx.core.widget.NestedScrollView': 'scroll-area',
  'android.widget.NumberPicker': 'spinbutton',
  'android.widget.DatePicker': 'combobox',
  'android.widget.TimePicker': 'combobox',
  'android.widget.RatingBar': 'slider',
  'android.widget.CalendarView': 'grid',
  'android.widget.TabHost': 'tablist',
  'com.google.android.material.chip.Chip': 'button',
  'com.google.android.material.floatingactionbutton.FloatingActionButton': 'button',
  'com.google.android.material.tabs.TabLayout': 'tablist',
  'com.google.android.material.textfield.TextInputEditText': 'textbox',
  'com.google.android.material.switchmaterial.SwitchMaterial': 'switch',
  'com.google.android.material.checkbox.MaterialCheckBox': 'checkbox',
}

export const IOS_ROLE_MAP: Record<string, string> = {
  'XCUIElementTypeButton': 'button',
  'XCUIElementTypeTextField': 'textbox',
  'XCUIElementTypeSecureTextField': 'textbox',
  'XCUIElementTypeStaticText': 'text',
  'XCUIElementTypeTextView': 'text',
  'XCUIElementTypeSwitch': 'switch',
  'XCUIElementTypeSlider': 'slider',
  'XCUIElementTypeImage': 'image',
  'XCUIElementTypeCell': 'cell',
  'XCUIElementTypeTable': 'list',
  'XCUIElementTypeCollectionView': 'list',
  'XCUIElementTypeScrollView': 'scroll-area',
  'XCUIElementTypeOther': 'group',
  'XCUIElementTypeGroup': 'group',
  'XCUIElementTypeNavigationBar': 'navigation',
  'XCUIElementTypeTabBar': 'tablist',
  'XCUIElementTypeSearchField': 'searchbox',
  'XCUIElementTypeCheckBox': 'checkbox',
  'XCUIElementTypeLink': 'link',
  'XCUIElementTypeAlert': 'alert',
  'XCUIElementTypeWebView': 'webview',
  'XCUIElementTypeApplication': 'application',
  'XCUIElementTypeWindow': 'window',
  'XCUIElementTypePicker': 'combobox',
  'XCUIElementTypePickerWheel': 'pickerwheel',
  'XCUIElementTypeSegmentedControl': 'tablist',
  'XCUIElementTypeStepper': 'spinbutton',
  'XCUIElementTypeDatePicker': 'combobox',
  'XCUIElementTypeMenu': 'menu',
  'XCUIElementTypeMenuItem': 'menuitem',
  'XCUIElementTypeMenuButton': 'button',
  'XCUIElementTypeToggle': 'switch',
  'XCUIElementTypePopUpButton': 'combobox',
  'XCUIElementTypeComboBox': 'combobox',
  'XCUIElementTypeRadioButton': 'radio',
  'XCUIElementTypeRadioGroup': 'group',
  'XCUIElementTypeToolbar': 'toolbar',
  'XCUIElementTypeProgressIndicator': 'progressbar',
  'XCUIElementTypeActivityIndicator': 'progressbar',
  'XCUIElementTypeColorWell': 'button',
}

export function normalizeRole(type: string, platform: 'android' | 'ios'): string {
  const map = platform === 'android' ? ANDROID_ROLE_MAP : IOS_ROLE_MAP
  const mapped = map[type]
  if (mapped) return mapped

  // Fallback: strip known prefixes and lowercase
  let fallback = type
  if (platform === 'ios') {
    fallback = fallback.replace(/^XCUIElementType/, '')
  } else {
    fallback = fallback
      .replace(/^android\.widget\./, '')
      .replace(/^android\.view\./, '')
      .replace(/^android\.webkit\./, '')
      .replace(/^androidx\.[\w.]+\./, '')
      .replace(/^com\.google\.android\.[\w.]+\./, '')
      .replace(/^com\.android\.[\w.]+\./, '')
  }
  return fallback.toLowerCase() || 'element'
}
