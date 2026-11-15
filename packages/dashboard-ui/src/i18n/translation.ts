type PluralFormsOf<K extends string> = K extends `${infer Base}_${'one' | 'other'}`
  ? `${Base}_${'zero' | 'one' | 'two' | 'few' | 'many' | 'other'}`
  : never

export type Translation<E extends Record<string, string>> = Partial<
  Record<keyof E | PluralFormsOf<keyof E & string>, string>
>
