/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {coerceBooleanProperty} from '@angular/cdk/coercion';
import {DOWN_ARROW} from '@angular/cdk/keycodes';
import {
  Directive,
  ElementRef,
  EventEmitter,
  forwardRef,
  Inject,
  Input,
  OnDestroy,
  Optional,
  Output,
} from '@angular/core';
import {
  AbstractControl,
  ControlValueAccessor,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  ValidationErrors,
  Validator,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import {
  DateAdapter,
  MAT_DATE_FORMATS,
  MatDateFormats,
  MatDateSelectionModel,
  MatSingleDateSelectionModel,
  ThemePalette,
  MatRangeDateSelectionModel
} from '@angular/material/core';
import {MatFormField} from '@angular/material/form-field';
import {MAT_INPUT_VALUE_ACCESSOR} from '@angular/material/input';
import {Subscription} from 'rxjs';
import {MatDatepicker} from './datepicker';
import {createMissingDateImplError} from './datepicker-errors';

/** @docs-private */
export const MAT_DATEPICKER_VALUE_ACCESSOR: any = {
  provide: NG_VALUE_ACCESSOR,
  useExisting: forwardRef(() => MatDatepickerInput),
  multi: true
};

/** @docs-private */
export const MAT_DATEPICKER_VALIDATORS: any = {
  provide: NG_VALIDATORS,
  useExisting: forwardRef(() => MatDatepickerInput),
  multi: true
};


/**
 * An event used for datepicker input and change events. We don't always have access to a native
 * input or change event because the event may have been triggered by the user clicking on the
 * calendar popup. For consistency, we always use MatDatepickerInputEvent instead.
 */
export class MatDatepickerInputEvent<D> {
  /** The new value for the target datepicker input. */
  value: D | null;

  constructor(
    /** Reference to the datepicker input component that emitted the event. */
    public target: MatDatepickerInput<D>,
    /** Reference to the native input element associated with the datepicker input. */
    public targetElement: HTMLElement) {
    this.value = this.target.value;
  }
}


/** Directive used to connect an input to a MatDatepicker. */
@Directive({
  selector: 'input[matDatepicker]',
  providers: [
    MAT_DATEPICKER_VALUE_ACCESSOR,
    MAT_DATEPICKER_VALIDATORS,
    {provide: MAT_INPUT_VALUE_ACCESSOR, useExisting: MatDatepickerInput},
  ],
  host: {
    '[attr.aria-haspopup]': 'true',
    '[attr.aria-owns]': '(_datepicker?.opened && _datepicker.id) || null',
    '[attr.min]': 'min ? _dateAdapter.toIso8601(min) : null',
    '[attr.max]': 'max ? _dateAdapter.toIso8601(max) : null',
    '[disabled]': 'disabled',
    '(input)': '_onInput($event.target.value)',
    '(change)': '_onChange()',
    '(blur)': '_onBlur()',
    '(keydown)': '_onKeydown($event)',
  },
  exportAs: 'matDatepickerInput',
})
export class MatDatepickerInput<D> implements ControlValueAccessor, OnDestroy, Validator {
  /** The datepicker that this input is associated with. */
  @Input()
  set matDatepicker(value: MatDatepicker<D>) {
    if (!value) {
      return;
    }

    this._datepicker = value;
    this._datepicker._registerInput(this);
    this._datepickerSubscription.unsubscribe();

    if (!this._isSelectionInitialized) {
      this._isSelectionInitialized = true;
      this._selectionModel.ngOnDestroy();
    }

    this._selectionModel = this._datepicker._dateSelection;

    this._formatValue(this._selectionModel.getSelection());

    this._datepickerSubscription = this._datepicker._dateSelection.selectionChange.subscribe(() => {
      this._formatValue(this._selectionModel.getSelection());
      this._cvaOnChange(this._selectionModel.getSelection());
      this._onTouched();
      this.dateInput.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
      this.dateChange.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
    });
  }
  _datepicker: MatDatepicker<D>;

  /** Function that can be used to filter out dates within the datepicker. */
  @Input()
  set matDatepickerFilter(value: (date: D | null) => boolean) {
    this._dateFilter = value;
    this._validatorOnChange();
  }
  _dateFilter: (date: D | null) => boolean;

  /** The value of the input. */
  @Input()
  get value(): D | null {
    return this._selectionModel ? this._selectionModel.getSelection() : null;
  }
  set value(value: D | null) {
    if (!this._isSelectionInitialized && value) {
      throw new Error('Input has no MatDatePicker associated with it.');
    }

    value = this._dateAdapter.deserialize(value);
    const oldDate = this._selectionModel.getSelection();

    if (!this._selectionModel) {
      throw new Error('Input has no MatDatePicker associated with it.');
    }

    if (!this._dateAdapter.sameDate(value, oldDate)) {
      this._selectionModel.setSelection(value);
    }

    this._lastValueValid = this._selectionModel.isValid();
    this._formatValue(this._selectionModel.getSelection());

    if (!this._dateAdapter.sameDate(value, oldDate)) {
      this._valueChange.emit(value);
    }
  }
  protected _selectionModel: MatSingleDateSelectionModel<D>;

  /** The minimum valid date. */
  @Input()
  get min(): D | null { return this._min; }
  set min(value: D | null) {
    this._min = this._getValidDateOrNull(this._dateAdapter.deserialize(value));
    this._validatorOnChange();
  }
  protected _min: D | null;

  /** The maximum valid date. */
  @Input()
  get max(): D | null { return this._max; }
  set max(value: D | null) {
    this._max = this._getValidDateOrNull(this._dateAdapter.deserialize(value));
    this._validatorOnChange();
  }
  protected _max: D | null;

  /** Whether the datepicker-input is disabled. */
  @Input()
  get disabled(): boolean { return !!this._disabled; }
  set disabled(value: boolean) {
    const newValue = coerceBooleanProperty(value);
    const element = this._elementRef.nativeElement;

    if (this._disabled !== newValue) {
      this._disabled = newValue;
      this._disabledChange.emit(newValue);
    }

    // We need to null check the `blur` method, because it's undefined during SSR.
    if (newValue && element.blur) {
      // Normally, native input elements automatically blur if they turn disabled. This behavior
      // is problematic, because it would mean that it triggers another change detection cycle,
      // which then causes a changed after checked error if the input element was focused before.
      element.blur();
    }
  }
  protected _disabled: boolean;

  /** Emits when a `change` event is fired on this `<input>`. */
  @Output() readonly dateChange: EventEmitter<MatDatepickerInputEvent<D>> =
      new EventEmitter<MatDatepickerInputEvent<D>>();

  /** Emits when an `input` event is fired on this `<input>`. */
  @Output() readonly dateInput: EventEmitter<MatDatepickerInputEvent<D>> =
      new EventEmitter<MatDatepickerInputEvent<D>>();

  /** Emits when the value changes (either due to user input or programmatic change). */
  _valueChange = new EventEmitter<D | null>();

  /** Emits when the disabled state has changed */
  _disabledChange = new EventEmitter<boolean>();

  _onTouched = () => {};

  protected _cvaOnChange: (value: any) => void = () => {};

  protected _validatorOnChange = () => {};

  protected _datepickerSubscription = Subscription.EMPTY;

  protected _localeSubscription = Subscription.EMPTY;

  protected _isSelectionInitialized = true;


  /** The form control validator for whether the input parses. */
  protected _parseValidator: ValidatorFn = (): ValidationErrors | null => {
    return this._lastValueValid ?
        null : {'matDatepickerParse': {'text': this._elementRef.nativeElement.value}};
  }

  /** The form control validator for the min date. */
  protected _minValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const controlValue = this._getValidDateOrNull(this._dateAdapter.deserialize(control.value));
    return (!this.min || !controlValue ||
        this._dateAdapter.compareDate(this.min, controlValue) <= 0) ?
        null : {'matDatepickerMin': {'min': this.min, 'actual': controlValue}};
  }

  /** The form control validator for the max date. */
  protected _maxValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const controlValue = this._getValidDateOrNull(this._dateAdapter.deserialize(control.value));
    return (!this.max || !controlValue ||
        this._dateAdapter.compareDate(this.max, controlValue) >= 0) ?
        null : {'matDatepickerMax': {'max': this.max, 'actual': controlValue}};
  }

  /** The form control validator for the date filter. */
  protected _filterValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const controlValue = this._getValidDateOrNull(this._dateAdapter.deserialize(control.value));
    return !this._dateFilter || !controlValue || this._dateFilter(controlValue) ?
        null : {'matDatepickerFilter': true};
  }

  /** The combined form control validator for this input. */
  protected _validator: ValidatorFn | null =
      Validators.compose(
          [this._parseValidator, this._minValidator, this._maxValidator, this._filterValidator]);

  /** Whether the last value set on the input was valid. */
  protected _lastValueValid = false;

  constructor(
      protected _elementRef: ElementRef<HTMLInputElement>,
      @Optional() public _dateAdapter: DateAdapter<D>,
      @Optional() @Inject(MAT_DATE_FORMATS) protected _dateFormats: MatDateFormats,
      @Optional() protected _formField: MatFormField) {
    if (!this._dateAdapter) {
      throw createMissingDateImplError('DateAdapter');
    }
    if (!this._dateFormats) {
      throw createMissingDateImplError('MAT_DATE_FORMATS');
    }

    // Update the displayed date when the locale changes.
    this._localeSubscription = _dateAdapter.localeChanges.subscribe(() => {
      this.value = this.value;
    });

    // Set a default model to prevent failure when reading value. Gets overridden when the
    // datepicker is set.
    this._selectionModel = new MatSingleDateSelectionModel(_dateAdapter);
  }

  ngOnDestroy() {
    this._datepickerSubscription.unsubscribe();
    this._localeSubscription.unsubscribe();
    this._valueChange.complete();
    this._disabledChange.complete();
  }

  /** @docs-private */
  registerOnValidatorChange(fn: () => void): void {
    this._validatorOnChange = fn;
  }

  /** @docs-private */
  validate(c: AbstractControl): ValidationErrors | null {
    return this._validator ? this._validator(c) : null;
  }

  /**
   * @deprecated
   * @breaking-change 8.0.0 Use `getConnectedOverlayOrigin` instead
   */
  getPopupConnectionElementRef(): ElementRef {
    return this.getConnectedOverlayOrigin();
  }

  /**
   * Gets the element that the datepicker popup should be connected to.
   * @return The element to connect the popup to.
   */
  getConnectedOverlayOrigin(): ElementRef {
    return this._formField ? this._formField.getConnectedOverlayOrigin() : this._elementRef;
  }

  // Implemented as part of ControlValueAccessor.
  writeValue(value: D): void {
    this.value = value;
  }

  // Implemented as part of ControlValueAccessor.
  registerOnChange(fn: (value: any) => void): void {
    this._cvaOnChange = fn;
  }

  // Implemented as part of ControlValueAccessor.
  registerOnTouched(fn: () => void): void {
    this._onTouched = fn;
  }

  // Implemented as part of ControlValueAccessor.
  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  _onKeydown(event: KeyboardEvent) {
    const isAltDownArrow = event.altKey && event.keyCode === DOWN_ARROW;

    if (this._datepicker && isAltDownArrow && !this._elementRef.nativeElement.readOnly) {
      this._datepicker.open();
      event.preventDefault();
    }
  }

  _onInput(value: string) {
    let date = this._dateAdapter.parse(value, this._dateFormats.parse.dateInput);
    const current = this._selectionModel.getSelection();
    date = this._getValidDateOrNull(date);

    if (!this._dateAdapter.sameDate(current, date)) {
      this._selectionModel.setSelection(date);
      this._cvaOnChange(date);
      this.dateInput.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
    } else {
      this._validatorOnChange();
    }
  }

  _onChange() {
    this.dateChange.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
  }

  /** Returns the palette used by the input's form field, if any. */
  _getThemePalette(): ThemePalette {
    return this._formField ? this._formField.color : undefined;
  }

  /** Handles blur events on the input. */
  _onBlur() {
    // Reformat the input only if we have a valid value.
    if (this.value) {
      this._formatValue(this.value);
    }

    this._onTouched();
  }

  /** Formats a value and sets it on the input element. */
  protected _formatValue(value: D | MatDateSelectionModel<D> | null) {
    if (value instanceof MatDateSelectionModel) {
      value = value.getFirstSelectedDate();
    }

    this._elementRef.nativeElement.value =
        value && this._getValidDateOrNull(value) ?
            this._dateAdapter.format(value, this._dateFormats.display.dateInput) : '';
  }

  /**
   * @param obj The object to check.
   * @returns The given object if it is both a date instance and valid, otherwise null.
   */
  protected _getValidDateOrNull(obj: any): D | null {
    return (this._dateAdapter.isDateInstance(obj) && this._dateAdapter.isValid(obj)) ? obj : null;
  }
}

@Directive({
  selector: 'input[matDatepickerStart]',
  providers: [
    MAT_DATEPICKER_VALUE_ACCESSOR,
    MAT_DATEPICKER_VALIDATORS,
    {provide: MAT_INPUT_VALUE_ACCESSOR, useExisting: MatDatepickerInput},
  ],
  host: {
    '[attr.aria-haspopup]': 'true',
    '[attr.aria-owns]': '(_datepicker?.opened && _datepicker.id) || null',
    '[attr.min]': 'min ? _dateAdapter.toIso8601(min) : null',
    '[attr.max]': 'max ? _dateAdapter.toIso8601(max) : null',
    '[disabled]': 'disabled',
    '(input)': '_onInput($event.target.value)',
    '(change)': '_onChange()',
    '(blur)': '_onBlur()',
    '(keydown)': '_onKeydown($event)',
  },
})
export class MatDatepickerInputStart<D> extends MatDatepickerInput<D> {
  @Input()
  set matDatepicker(value: MatDatepicker<D>) {
    if (!value) {
      return;
    }

    this._datepicker = value;
    this._datepickerSubscription.unsubscribe();

    if (this._isSelectionInitialized) {
      this._isSelectionInitialized = false;
      this._selectionModel.ngOnDestroy();
    }

    this._selectionModel = this._datepicker._dateSelection;

    this._formatValue(this._selectionModel.getFirstSelectedDate());

    this._datepickerSubscription = this._datepicker._dateSelection.selectionChange.subscribe(() => {
      this._formatValue(this._selectionModel.getFirstSelectedDate());
      this._cvaOnChange(this._selectionModel.getFirstSelectedDate());
      this._onTouched();
      this.dateInput.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
      this.dateChange.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
    });
  }

  _onInput(value: string) {
    if ( this._selectionModel instanceof MatRangeDateSelectionModel ) {
      let date = this._dateAdapter.parse(value, this._dateFormats.parse.dateInput);
      const current = this._selectionModel.getFirstSelectedDate();
      date = this._getValidDateOrNull(date);

      if (!this._dateAdapter.sameDate(current, date)) {
        this._selectionModel.setPartialSelection(date);
        this._formatValue(date);
        this._cvaOnChange(date);
        this.dateInput.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
      } else {
        this._validatorOnChange();
      }
    }
  }

  _onChange() {}
}

@Directive({
  selector: 'input[matDatepickerEnd]',
  providers: [
    MAT_DATEPICKER_VALUE_ACCESSOR,
    MAT_DATEPICKER_VALIDATORS,
    {provide: MAT_INPUT_VALUE_ACCESSOR, useExisting: MatDatepickerInput},
  ],
  host: {
    '[attr.aria-haspopup]': 'true',
    '[attr.aria-owns]': '(_datepicker?.opened && _datepicker.id) || null',
    '[attr.min]': 'min ? _dateAdapter.toIso8601(min) : null',
    '[attr.max]': 'max ? _dateAdapter.toIso8601(max) : null',
    '[disabled]': 'disabled',
    '(input)': '_onInput($event.target.value)',
    '(change)': '_onChange()',
    '(blur)': '_onBlur()',
    '(keydown)': '_onKeydown($event)',
  },
})
export class MatDatepickerInputEnd<D> extends MatDatepickerInput<D> {
  @Input()
  set matDatepicker(value: MatDatepicker<D>) {
    if (!value) {
      return;
    }

    this._datepicker = value;
    this._datepickerSubscription.unsubscribe();

    if (this._isSelectionInitialized) {
      this._isSelectionInitialized = false;
      this._selectionModel.ngOnDestroy();
    }

    this._selectionModel = this._datepicker._dateSelection;

    this._formatValue(this._selectionModel.getLastSelectedDate());

    this._datepickerSubscription = this._datepicker._dateSelection.selectionChange.subscribe(() => {
      this._formatValue(this._selectionModel.getLastSelectedDate());
      this._cvaOnChange(this._selectionModel.getLastSelectedDate());
      this._onTouched();
      this.dateInput.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
      this.dateChange.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
    });
  }

  _onInput(value: string) {
    if ( this._selectionModel instanceof MatRangeDateSelectionModel ) {
      let date = this._dateAdapter.parse(value, this._dateFormats.parse.dateInput);
      const current = this._selectionModel.getLastSelectedDate();
      date = this._getValidDateOrNull(date);

      if (!this._dateAdapter.sameDate(current, date)) {
        this._selectionModel.setPartialSelection(undefined, date);
        this._formatValue(date);
        this._cvaOnChange(date);
        this.dateInput.emit(new MatDatepickerInputEvent(this, this._elementRef.nativeElement));
      } else {
        this._validatorOnChange();
      }
    }
  }

  _onChange() {}
}
