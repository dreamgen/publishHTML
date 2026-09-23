import { S } from './state.js';
import { renderTeacher } from './teacher.js';
import { renderStudent } from './student.js';

/** 依目前角色重畫主畫面；需要重畫時從這裡 import，不要在其他模組頂層直接判斷角色再各自呼叫。 */
export function rerender() {
  if (!S.session) return;
  if (S.session.role === 'teacher') renderTeacher();
  else renderStudent();
}
