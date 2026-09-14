export type Filter = {
  field: string
  op: '==' | '>=' | '<=' | 'in'
  value: unknown
}
export type Selections = Record<string, Filter[][]>
