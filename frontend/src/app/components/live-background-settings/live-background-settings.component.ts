import { Component, inject, ViewEncapsulation, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LiveBackgroundService } from '../../services/live-background.service';
import { I18nService } from '../../services/i18n.service';

@Component({
  selector: 'app-live-background-settings',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './live-background-settings.component.html',
  styleUrl: './live-background-settings.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class LiveBackgroundSettingsComponent {
  readonly bgService = inject(LiveBackgroundService);
  readonly i18n = inject(I18nService);

  @HostListener('window:keydown.escape')
  handleEscape() {
    if (this.bgService.isSettingsOpen()) {
      this.bgService.closeSettings();
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.bgService.handleFileUpload(input.files[0]);
    }
  }

  onDropFile(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files && event.dataTransfer.files[0]) {
      this.bgService.handleFileUpload(event.dataTransfer.files[0]);
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
  }
}
