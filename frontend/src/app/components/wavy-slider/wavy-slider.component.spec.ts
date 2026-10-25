import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WavySliderComponent } from './wavy-slider.component';

describe('WavySliderComponent', () => {
  let component: WavySliderComponent;
  let fixture: ComponentFixture<WavySliderComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WavySliderComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(WavySliderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create wavy slider component', () => {
    expect(component).toBeTruthy();
  });

  it('should format time correctly', () => {
    expect(component.formatTime(0)).toBe('0:00');
    expect(component.formatTime(65)).toBe('1:05');
    expect(component.formatTime(125)).toBe('2:05');
    expect(component.formatTime(3600)).toBe('60:00');
  });

  it('should handle keyboard navigation on ArrowRight and ArrowLeft', () => {
    component.max = 100;
    component.value = 50;

    let seekValue = -1;
    component.seek.subscribe((val) => (seekValue = val));

    const eventRight = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    component.onKeyDown(eventRight);
    expect(seekValue).toBeGreaterThan(50);

    const eventLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
    component.onKeyDown(eventLeft);
    expect(seekValue).toBeLessThan(50);
  });
});
